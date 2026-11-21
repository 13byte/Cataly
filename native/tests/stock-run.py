"""Exercise the Rust harness with a stock OMP and a loopback-only model fixture."""

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import sys
import tempfile
from threading import Event, Thread


REQUEST_PREFIX = "cataly-test: "


class Model(BaseHTTPRequestHandler):
    calls: list[str] = []
    interrupted = Event()
    release = Event()

    def do_POST(self) -> None:
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        prompt = body["messages"][-1]["content"]
        if not isinstance(prompt, str):
            prompt = "".join(part["text"] for part in prompt if part["type"] == "text")
        # OMP may prepend its context reminder to the final user message.
        for opener, closer in (("<system-reminder>", "</system-reminder>"),
                               ("&lt;system-reminder>", "&lt;/system-reminder>")):
            if prompt.startswith(opener):
                _, found, prompt = prompt.partition(closer)
                assert found, "expected the stock OMP context reminder to end"
                break
        # Stock OMP can also send independent provider capability probes.
        lane_request = prompt.startswith(REQUEST_PREFIX)
        if lane_request:
            prompt = prompt.removeprefix(REQUEST_PREFIX)
            self.calls.append(prompt)
        if lane_request and prompt == "interrupt fixture":
            self.interrupted.set()
            self.release.wait(20)
        if lane_request and prompt == "provider error fixture":
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error":{"message":"fixture failure"}}')
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        text = f"확인: {prompt}" if lane_request else "391"
        chunks = [({"role": "assistant", "content": text}, None), ({}, "stop")]
        for delta, finish in chunks:
            data = {"id": "cataly-fixture", "object": "chat.completion.chunk", "created": 0,
                    "model": body["model"], "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            self.wfile.write(f"data: {json.dumps(data)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")

    def log_message(self, *_args: object) -> None:
        pass


def run(key: str, request_id: str, prompt: str) -> dict[str, str]:
    return {"op": "run", "key": key, "id": request_id, "prompt": REQUEST_PREFIX + prompt}


def run_harness(command: list[str], env: dict[str, str], *requests: dict[str, str]) -> list[dict]:
    data = "".join(json.dumps(request) + "\n" for request in requests)
    result = subprocess.run(command, env=env, input=data, capture_output=True, text=True, timeout=45, check=False)
    if result.returncode != 0:
        raise AssertionError(f"Cataly exited {result.returncode}: {result.stderr}")
    return [json.loads(line) for line in result.stdout.splitlines()]


def exercise(command: list[str], env: dict[str, str]) -> None:
    request = run("lane", "answer-1", "first request")
    receipt = {"op": "receipt", "id": "answer-1"}
    first, repeated, looked_up, conflict, second, failed, parked = run_harness(
        command, env, request, request, receipt, run("lane", "answer-1", "different"),
        run("lane", "answer-2", "second request"), run("lane", "fail-1", "provider error fixture"),
        {"op": "status", "key": "lane"},
    )
    assert first["status"] == "completed" and first["text"] == "확인: first request", first
    assert first == repeated == looked_up and first["claim"]["id"] == "answer-1"
    assert "already used" in conflict["error"], conflict
    assert second["text"] == "확인: second request" and second["claim"]["session_id"] == first["claim"]["session_id"], second
    assert failed["status"] == "failed" and "text" not in failed, failed
    assert parked["state"] == "parked", parked
    saved, replay = run_harness(command, env, receipt, request)
    assert saved == replay == first
    assert Model.calls == ["first request", "second request", "provider error fixture"], Model.calls

    lost = run("other", "lost-1", "interrupt fixture")
    with subprocess.Popen(command, env=env, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, text=True) as owner:
        try:
            if owner.stdin is None:
                raise AssertionError("expected controller stdin")
            owner.stdin.write(json.dumps(lost) + "\n")
            owner.stdin.flush()
            assert Model.interrupted.wait(20), "model did not receive request"
        finally:
            owner.kill()
            owner.wait(timeout=15)
            Model.release.set()
    pending, replay, hold = run_harness(command, env, {"op": "receipt", "id": "lost-1"}, lost, run("other", "new-id", "must not run"))
    assert pending == replay and pending["status"] == "unconfirmed", (pending, replay)
    assert "unconfirmed request" in hold["error"], hold
    assert Model.calls[-1] == "interrupt fixture" and Model.calls.count("interrupt fixture") == 1, Model.calls


def main() -> None:
    cataly, omp = (str(Path(arg).resolve(strict=True)) for arg in sys.argv[1:])
    with tempfile.TemporaryDirectory(prefix="cataly-turn-") as tmp, ThreadingHTTPServer(("127.0.0.1", 0), Model) as server:
        root = Path(tmp)
        for name in ("home", "agent", "project"):
            (root / name).mkdir(mode=0o700)
        (root / "agent" / "models.yml").write_text(f"""providers:
  cataly-fixture:
    baseUrl: http://127.0.0.1:{server.server_port}/v1
    apiKey: cataly-fixture
    api: openai-completions
    models:
      - id: local
        name: Cataly fixture
        contextWindow: 8192
        maxTokens: 512
""", encoding="utf-8")
        env = {"PATH": os.environ["PATH"], "HOME": str(root / "home"), "PI_CODING_AGENT_DIR": str(root / "agent")}
        command = [cataly, "--omp", omp, "--cwd", str(root / "project"), "--model", "cataly-fixture/local",
                   "harness", "--state-dir", str(root / "state")]
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            exercise(command, env)
        finally:
            server.shutdown()
            thread.join()
    print("Cataly stock OMP turn, durable replay, provider error and interrupted delivery: OK")


if __name__ == "__main__":
    main()
