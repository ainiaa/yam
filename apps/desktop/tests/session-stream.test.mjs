import assert from "node:assert/strict";
import { test } from "node:test";
import { OutputBuffer, replayOutput, consumeOutput } from "../src/session-stream.ts";

const chunk = (offset, data, id = "s-test") => ({session_id:id, data, offset, end_offset:offset + Buffer.byteLength(data)});
test("log snapshot and live chunks replay each byte only once", () => {
  const result = replayOutput({data:"hello\n", offset:0, end_offset:6}, [chunk(0,"hello\n"),chunk(6,"中文"),chunk(6,"中文")]);
  assert.equal(result.data,"hello\n中文");
  assert.equal(result.nextOffset,12);
});
test("out of order buffered events are sorted and overlapping events are trimmed", () => {
  const result = replayOutput({data:"ab",offset:0,end_offset:2},[chunk(4,"ef"),chunk(0,"abcd")]);
  assert.equal(result.data,"abcdef");
  assert.equal(consumeOutput(6,chunk(0,"abc")).data, "");
});
test("gaps require a new snapshot instead of silently losing output", () => {
  assert.throws(()=>consumeOutput(2,chunk(5,"end")),/gap/i);
  assert.throws(()=>replayOutput({data:"",offset:10,end_offset:10},[chunk(12,"x")]),/gap/i);
});
test("background caches bound bytes and sessions and release terminal records", () => {
  const buffer = new OutputBuffer(8,2);
  for(let i=0;i<100;i++) buffer.push(chunk(i*4,"abcd","s-one"));
  assert.ok(buffer.byteLength("s-one")<=8);
  buffer.push(chunk(0,"ab","s-two"));buffer.push(chunk(0,"cd","s-three"));
  assert.equal(buffer.size,2);
  assert.deepEqual(buffer.drain("s-one"),[]);
  assert.equal(buffer.drain("s-three")[0].data,"cd");
  buffer.delete("s-two");assert.equal(buffer.size,0);
});
test("large Unicode chunks retain a valid bounded tail", () => {
  const buffer = new OutputBuffer(7,1);
  buffer.push(chunk(0,"中文测试"));
  const tail = buffer.drain("s-test")[0];
  assert.ok(Buffer.byteLength(tail.data)<=7);
  assert.equal(tail.data,"测试");
  assert.equal(tail.offset,6);
});

test("output offsets and cache limits reject invalid numeric boundaries", () => {
 for (const cursor of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
  assert.throws(() => consumeOutput(cursor, chunk(0, "abc")), /offset/i);
 for (const bad of [chunk(-1, "abc"), {...chunk(0,"abc"), end_offset:2}, {...chunk(0,"abc"), offset:NaN}])
  assert.throws(() => consumeOutput(0,bad), /offset/i);
 for (const value of [0,-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER + 1]) {
  assert.throws(() => new OutputBuffer(value,1));
  assert.throws(() => new OutputBuffer(1,value));
 }
 const buffer = new OutputBuffer();
 assert.equal(buffer.byteLength("missing"),0);
 buffer.push(chunk(0,"abc"));
 buffer.clear();
 assert.equal(buffer.size,0);
 assert.deepEqual(buffer.drain("s-test"),[]);
});
