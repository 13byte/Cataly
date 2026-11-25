"""Drive Discord send through the native binary against the stock loopback fixture."""

import json
import subprocess
import tempfile
from collections.abc import Sequence
from hashlib import sha256
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from discord_wire import World


def exercise_send(binary: str, env: dict[str, str], world: "World") -> None:
    def run(text: str, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [binary, "discord-send", *args], env={**env, "CATALY_DISCORD_GUILD_ID": "40"},
            input=text, capture_output=True, text=True, check=False, timeout=10,
        )

    def sent(text: str, args: Sequence[str], confirmed: bool, count: int) -> list[dict]:
        result = run(text, *args)
        assert result.returncode == 0, result.stderr
        receipt = json.loads(result.stdout)
        assert receipt["channel"] == "20" and receipt["replyConfirmed"] is confirmed, receipt
        assert len(receipt["ids"]) == count, receipt
        return [world.replies.get(timeout=2) for _ in receipt["ids"]]

    text = "한" * 1999 + "😀" + " tail"
    first, second = sent(text, ("--to", "#work", "--reply", "100"), True, 2)
    assert first["message_reference"] == {"message_id": "100", "channel_id": "20", "fail_if_not_exists": True}
    assert "message_reference" not in second and first["content"] + second["content"] == text
    assert first["allowed_mentions"] == {"parse": [], "replied_user": False}

    body = "가😀code\n" * 530
    fenced = "```rust\n" + body + "```"
    pieces = sent(fenced, ("--thread", "20"), False, 3)
    contents = [part["content"] for part in pieces]
    assert all(part.startswith("```rust\n") and part.endswith("\n```") for part in contents), contents
    assert all(len(part.encode("utf-16-le")) // 2 <= 2000 for part in contents)
    assert "".join(part.removeprefix("```rust\n").removesuffix("```") for part in contents) == body

    world.force_plain_reply = True
    sent("server did not confirm reply", ("--thread", "20", "--reply", "100"), False, 1)
    world.force_plain_reply = False

    world.reject_text = "blocked continuation"
    result = run("x" * 2000 + world.reject_text, "--thread", "20")
    assert result.returncode != 0 and "stopped at part 2" in result.stderr and "confirmed IDs: [" in result.stderr, result
    assert world.replies.get(timeout=2)["content"] == "x" * 2000
    assert world.replies.empty()

    result = run("changed", "--to", "20", "--edit", "300")
    assert result.returncode == 0 and json.loads(result.stdout)["ids"] == [], result
    assert world.cleared.get(timeout=2)["content"] == "changed"
    for args in [("--to", "21"), ("--thread", "20", "--edit", "300", "--reply", "100")]:
        denied = run("no effect", *args)
        assert denied.returncode != 0, denied
    assert world.replies.empty() and world.cleared.empty()

    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "결과 report.txt"
        path.write_bytes(b"stock file\n")
        stored = {"filename": path.name, "size": 11, "sha256": sha256(b"stock file\n").hexdigest()}
        admitted = f"{stored['sha256']}:11:{path}"
        world.rate_limit = True
        result = run("with a file", "--thread", "20", "--reply", "100", "--file", admitted)
        assert result.returncode == 0, result.stderr
        receipt = json.loads(result.stdout)
        assert receipt["replyConfirmed"] is True and len(receipt["ids"]) == 1, receipt
        assert receipt["attachments"] == [{"id": "900", **stored}], receipt
        posted = world.replies.get(timeout=2)
        assert posted["files"] == [{"field": "files[0]", **stored}] and posted["content"] == "with a file", posted
        assert posted["attachments"] == [{"id": 0, "filename": path.name}] and posted["enforce_nonce"] is True, posted
        assert posted["message_reference"] == first["message_reference"], posted
        # The rate-limited attempt and its single retry carried the same enforced nonce.
        assert world.nonces[-2:] == [posted["nonce"]] * 2 and len(posted["nonce"]) == 24, world.nonces
        # Bytes that no longer match the admitted size and SHA-256 are refused before any request.
        path.write_bytes(b"other file\n")
        for stale in (admitted, f"{stored['sha256']}:10:{path}"):
            changed = run("", "--thread", "20", "--file", stale)
            assert changed.returncode == 1 and "changed after it was admitted" in changed.stderr, changed
        current = f"{sha256(path.read_bytes()).hexdigest()}:11:{path}"
        world.reject_text = "refused file"
        refused = run(world.reject_text, "--thread", "20", "--file", current)
        assert refused.returncode == 1 and "nothing was posted" in refused.stderr, refused
        assert run("no effect", "--thread", "20", "--edit", "300", "--file", current).returncode == 2
    assert world.replies.empty() and world.cleared.empty()
