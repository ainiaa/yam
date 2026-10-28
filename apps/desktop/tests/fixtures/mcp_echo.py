"""Author: Jeff.Liu. Stdio MCP fixture; no network or user configuration."""
import json
import sys
for line in sys.stdin:
    request = json.loads(line)
    if 'id' not in request:
        continue
    method = request.get('method')
    if method == 'initialize':
        result = {'protocolVersion': '2024-11-05', 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'yam-echo', 'version': '1'}}
    elif method == 'tools/list':
        result = {'tools': [{'name': 'echo', 'description': 'Return the provided fixture text', 'annotations': {'readOnlyHint': True, 'destructiveHint': False, 'openWorldHint': False, 'idempotentHint': True}, 'inputSchema': {'type': 'object', 'properties': {'text': {'type': 'string'}}, 'required': ['text']}}]}
    elif method == 'tools/call':
        result = {'content': [{'type': 'text', 'text': request.get('params', {}).get('arguments', {}).get('text', '')}]}
    else:
        result = {}
    print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}), flush=True)
