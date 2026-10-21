"""Author: Jeff.Liu. Loopback-only protocol fixture; never forwards requests."""
import argparse
import base64
from email.parser import BytesParser
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
import time
import uuid

IMAGE = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC")


def serve(token, receipt_path):
    gate = threading.Lock()
    call_id = "call_yam_probe"
    tool_marker = "YAM_TOOL_OUTPUT_" + token

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def send_json(self, value, status=200):
            data = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            self.send_json({"data": [], "models": []})

        def do_POST(self):
            size = int(self.headers.get("Content-Length", "0"))
            if size > 8 * 1024 * 1024:
                self.send_error(413)
                return
            raw = self.rfile.read(size)
            if self.headers.get("Content-Type", "").startswith("multipart/form-data"):
                parts = BytesParser().parsebytes(("Content-Type: " + self.headers["Content-Type"] + "\r\nMIME-Version: 1.0\r\n\r\n").encode() + raw)
                body = {part.get_param("name", header="content-disposition"): part.get_payload(decode=True).decode() for part in parts.walk() if part.get_content_maintype() == "text" and part.get_param("name", header="content-disposition")}
                body["edit_images"] = sum(bool(part.get_filename()) for part in parts.walk())
            else:
                body = json.loads(raw)
            serialized = json.dumps(body)
            initial = token in serialized
            followup = "YAM_FOLLOWUP" in serialized
            auth = self.headers.get("Authorization", "") or self.headers.get("x-api-key", "") or self.headers.get("x-goog-api-key", "")
            if self.path.rstrip("/").endswith(("images/generations", "images/edits")):
                with gate, receipt_path.open("a") as output:
                    output.write(json.dumps({"path": self.path, "image_request": True, "model": body.get("model"), "local_key": auth == "Bearer yam-local-gateway", "official_key_seen": "official-key-do-not-use" in auth, "edit_images": body.get("edit_images", 0)}) + "\n")
                if "YAM_IMAGE_ERROR" in body.get("prompt", ""):
                    self.send_json({"error": {"message": "YAM_LOCAL_IMAGE_REFUSAL", "type": "invalid_request_error", "code": "fixture_refusal"}}, 400)
                else:
                    self.send_json({"created": int(time.time()), "data": [{"b64_json": base64.b64encode(IMAGE).decode()}]})
                return
            tools = []
            namespaces = {}
            wire_tools = list(body.get("tools", []))
            for item in body.get("input", []):
                if isinstance(item, dict) and item.get("type") == "additional_tools":
                    wire_tools.extend(item.get("tools", []))
            for tool in wire_tools:
                if isinstance(tool, dict):
                    tools.extend(tool.get("tools", []) if tool.get("type") == "namespace" else [tool])
                    if tool.get("type") == "namespace":
                        namespaces.update({nested.get("name"): tool.get("name") for nested in tool.get("tools", [])})
            available = {tool["name"]: tool for tool in tools if isinstance(tool, dict) and isinstance(tool.get("name"), str)}
            last_user = next((message.get("content") for message in reversed(body.get("messages", []) or body.get("input", [])) if isinstance(message, dict) and message.get("role") == "user"), "")
            direct_text = last_user if isinstance(last_user, str) else "\n".join(block.get("text", "") for block in last_user if isinstance(block, dict) and block.get("type") in ["text", "input_text"]) if isinstance(last_user, list) else ""
            subtask_child = "YAM_SUBTASK_CHILD" in direct_text
            outputs = [item.get("output") for item in body.get("input", []) if isinstance(item, dict) and item.get("type") in ["function_call_output", "custom_tool_call_output"] and item.get("call_id") == call_id]
            for message in body.get("messages", []):
                if isinstance(message, dict) and isinstance(message.get("content"), list):
                    outputs.extend(block.get("content") for block in message["content"] if isinstance(block, dict) and block.get("type") == "tool_result" and block.get("tool_use_id") == call_id)
            tool_result_seen = bool(outputs)
            tool_output_ok = any(tool_marker in json.dumps(output) for output in outputs)
            tool_name, arguments = None, None
            response_call_id = call_id
            shell = None
            if "YAM_IMAGE_PROBE" in serialized and not tool_result_seen:
                shell = (receipt_path.parent / "image-command.txt").read_text()
            if ("YAM_TOOL_PROBE" in serialized or "YAM_SUBTASK_PROBE" in serialized) and not tool_result_seen and not subtask_child and "count" not in self.path:
                if "YAM_SUBTASK_PROBE" in serialized and "messages" in self.path and "Agent" in available:
                    tool_name, arguments = "Agent", {"description": "Model route probe", "prompt": "YAM_SUBTASK_CHILD: Reply exactly " + tool_marker + ". Do not use tools.", "subagent_type": "general-purpose", "model": "haiku"}
                elif "messages" in self.path and "Read" in available:
                    tool_name, arguments = "Read", {"file_path": str(receipt_path.parent / "project/probe.txt")}
                elif self.path.rstrip("/").endswith("responses"):
                    shell = "/bin/cat probe.txt"
                    for name in ["shell_command", "exec_command", "shell"]:
                        if name in available:
                            tool_name = name
                            arguments = {"command": "/bin/cat probe.txt"} if name == "shell_command" else {"cmd": "/bin/cat probe.txt"} if name == "exec_command" else {"command": ["/bin/cat", "probe.txt"]}
                            break
            if shell and "exec" in available and available["exec"].get("type") == "custom":
                tool_name = "exec"
                arguments = "text(await tools.exec_command(" + json.dumps({"cmd": shell, "login": False, "yield_time_ms": 10000}) + "));"
            if "YAM_MCP_PROBE" in serialized and not tool_result_seen and "exec" in available:
                tool_name, arguments = "exec", "text(await tools.mcp__fixture__echo(" + json.dumps({"text": tool_marker}) + "));"
            if "YAM_CODEX_CHILD_PROBE" in serialized and not tool_result_seen and not subtask_child and "exec" in available:
                tool_name = "exec"
                arguments = "const n=ALL_TOOLS.find(t=>/^(multi_agent_v1__)?spawn_agent$/.test(t.name))?.name;if(!n)throw Error('No spawn tool');const c=await tools[n]({message:" + json.dumps("YAM_SUBTASK_CHILD: Reply exactly " + tool_marker + ". Do not use tools.") + ",agent_type:'reviewer',...(n==='spawn_agent'?{task_name:'inheritance_child'}:{})});text(c);if(n==='multi_agent_v1__spawn_agent'){const v=typeof c==='string'?JSON.parse(c):c;text(await tools.multi_agent_v1__wait_agent({ids:[v.agent_id],timeout_ms:10000}));}else{text(await tools.wait_agent({timeout_ms:10000}));text(await tools.list_agents({}));}"
            if "YAM_MCP_PROBE" in serialized and not tool_result_seen and "echo" in available:
                tool_name, arguments = "echo", {"text": tool_marker}
            if "YAM_CODEX_CHILD_PROBE" in serialized and not subtask_child and "exec" not in available:
                if not tool_result_seen and "spawn_agent" in available:
                    tool_name, arguments = "spawn_agent", {"message": "YAM_SUBTASK_CHILD: Reply exactly " + tool_marker + ". Do not use tools.", "agent_type": "reviewer"}
                    if "task_name" in available["spawn_agent"].get("parameters", {}).get("required", []):
                        arguments["task_name"] = "inheritance_child"
                elif tool_result_seen and "wait_agent" in available and not any(isinstance(i, dict) and i.get("call_id") == call_id + "_wait" for i in body.get("input", [])):
                    try:
                        child = json.loads(outputs[-1]) if isinstance(outputs[-1], str) else outputs[-1]
                        tool_name, arguments = "wait_agent", {next((key for key, schema in available["wait_agent"].get("parameters", {}).get("properties", {}).items() if schema.get("type") == "array"), "targets"): [child["agent_id"]], "timeout_ms": 10000}
                        response_call_id = call_id + "_wait"
                    except (ValueError, KeyError, TypeError):
                        pass
            with gate, receipt_path.open("a") as output:
                output.write(json.dumps({"path": self.path, "initial": initial, "followup": followup, "local_key": "yam-local-gateway" in auth, "model": body.get("model"), "stream": body.get("stream") is True, "tool_names": sorted(available)[:64], "tool_issued": tool_name is not None, "tool_result_seen": tool_result_seen, "tool_output_ok": tool_output_ok, "subtask_child": subtask_child, "image_route_instructions": "YAM session image API route" in serialized, "project_instructions_preserved": "YAM_PROJECT_INSTRUCTIONS_SENTINEL" in serialized}) + "\n")
            text = token if initial else "NO_SAVED_CONTEXT"
            if subtask_child:
                text = tool_marker
            if tool_result_seen and not tool_output_ok and "YAM_SUBTASK_PROBE" not in serialized and "YAM_IMAGE_PROBE" not in serialized and "YAM_CODEX_CHILD_PROBE" not in serialized:
                text = "TOOL_RESULT_MISSING"
            if "count_tokens" in self.path:
                self.send_json({"input_tokens": 20})
                return
            if "countTokens" in self.path:
                self.send_json({"totalTokens": 20})
                return
            if "messages" in self.path:
                model = body.get("model", "mock-model")
                events = [
                    ("message_start", {"type": "message_start", "message": {"id": "msg_" + uuid.uuid4().hex, "type": "message", "role": "assistant", "content": [], "model": model, "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 20, "output_tokens": 0}}}),
                    ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
                    ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}}),
                    ("content_block_stop", {"type": "content_block_stop", "index": 0}),
                    ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 5}}),
                    ("message_stop", {"type": "message_stop"}),
                ]
                if not body.get("stream"):
                    content = [{"type": "tool_use", "id": call_id, "name": tool_name, "input": arguments}] if tool_name else [{"type": "text", "text": text}]
                    self.send_json({"id": "msg_" + uuid.uuid4().hex, "type": "message", "role": "assistant", "content": content, "model": model, "stop_reason": "tool_use" if tool_name else "end_turn", "stop_sequence": None, "usage": {"input_tokens": 20, "output_tokens": 5}})
                    return
                if tool_name:
                    events = [events[0],
                        ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": call_id, "name": tool_name, "input": {}}}),
                        ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": json.dumps(arguments)}}),
                        ("content_block_stop", {"type": "content_block_stop", "index": 0}),
                        ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "tool_use", "stop_sequence": None}, "usage": {"output_tokens": 5}}),
                        ("message_stop", {"type": "message_stop"})]
            elif "GenerateContent" in self.path or "generateContent" in self.path:
                value = {"candidates": [{"content": {"role": "model", "parts": [{"text": text}]}, "finishReason": "STOP", "index": 0}], "usageMetadata": {"promptTokenCount": 20, "candidatesTokenCount": 5, "totalTokenCount": 25}, "modelVersion": "gemini-3-flash-preview", "responseId": uuid.uuid4().hex}
                if "streamGenerateContent" not in self.path:
                    self.send_json(value)
                    return
                events = [(None, value)]
            elif self.path.rstrip("/").endswith("responses"):
                response_id = "resp_" + uuid.uuid4().hex
                message = {"id": "msg_" + uuid.uuid4().hex, "type": "message", "status": "completed", "role": "assistant", "content": [{"type": "output_text", "text": text, "annotations": []}]}
                response = {"id": response_id, "object": "response", "created_at": int(time.time()), "status": "completed", "model": body.get("model"), "output": [message], "usage": {"input_tokens": 20, "output_tokens": 5, "total_tokens": 25}}
                events = [
                    ("response.created", {"type": "response.created", "response": {**response, "status": "in_progress", "output": []}}),
                    ("response.output_item.added", {"type": "response.output_item.added", "output_index": 0, "item": {**message, "status": "in_progress", "content": []}}),
                    ("response.content_part.added", {"type": "response.content_part.added", "item_id": message["id"], "output_index": 0, "content_index": 0, "part": {"type": "output_text", "text": "", "annotations": []}}),
                    ("response.output_text.delta", {"type": "response.output_text.delta", "item_id": message["id"], "output_index": 0, "content_index": 0, "delta": text}),
                    ("response.output_text.done", {"type": "response.output_text.done", "item_id": message["id"], "output_index": 0, "content_index": 0, "text": text}),
                    ("response.content_part.done", {"type": "response.content_part.done", "item_id": message["id"], "output_index": 0, "content_index": 0, "part": message["content"][0]}),
                    ("response.output_item.done", {"type": "response.output_item.done", "output_index": 0, "item": message}),
                    ("response.completed", {"type": "response.completed", "response": response}),
                ]
                if tool_name:
                    item = {"id": "fc_" + uuid.uuid4().hex, "type": "function_call", "status": "completed", "call_id": response_call_id, "name": tool_name, "arguments": json.dumps(arguments)}
                    if tool_name in namespaces:
                        item["namespace"] = namespaces[tool_name]
                    if tool_name == "exec":
                        item["type"] = "custom_tool_call"
                        item["input"] = arguments
                        del item["arguments"]
                        response["output"] = [item]
                        events = [
                            ("response.created", {"type": "response.created", "response": {**response, "status": "in_progress", "output": []}}),
                            ("response.output_item.added", {"type": "response.output_item.added", "output_index": 0, "item": {**item, "status": "in_progress", "input": ""}}),
                            ("response.custom_tool_call_input.delta", {"type": "response.custom_tool_call_input.delta", "item_id": item["id"], "output_index": 0, "delta": arguments}),
                            ("response.custom_tool_call_input.done", {"type": "response.custom_tool_call_input.done", "item_id": item["id"], "output_index": 0, "input": arguments}),
                            ("response.output_item.done", {"type": "response.output_item.done", "output_index": 0, "item": item}),
                            ("response.completed", {"type": "response.completed", "response": response})]
                    else:
                        events = None
                    response["output"] = [item]
                    events = events or [
                        ("response.created", {"type": "response.created", "response": {**response, "status": "in_progress", "output": []}}),
                        ("response.output_item.added", {"type": "response.output_item.added", "output_index": 0, "item": {**item, "status": "in_progress", "arguments": ""}}),
                        ("response.function_call_arguments.delta", {"type": "response.function_call_arguments.delta", "item_id": item["id"], "output_index": 0, "delta": item["arguments"]}),
                        ("response.function_call_arguments.done", {"type": "response.function_call_arguments.done", "item_id": item["id"], "output_index": 0, "arguments": item["arguments"]}),
                        ("response.output_item.done", {"type": "response.output_item.done", "output_index": 0, "item": item}),
                        ("response.completed", {"type": "response.completed", "response": response})]
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Connection", "close")
            self.end_headers()
            try:
                for event, value in events:
                    if event:
                        self.wfile.write(f"event: {event}\n".encode())
                    self.wfile.write(f"data: {json.dumps(value)}\n\n".encode())
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            self.close_connection = True

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    print(json.dumps({"base_url": f"http://127.0.0.1:{server.server_port}"}), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--token", required=True)
    parser.add_argument("--receipts", type=Path, required=True)
    args = parser.parse_args()
    serve(args.token, args.receipts)
