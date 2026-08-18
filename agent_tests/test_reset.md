# Purpose

Verify that exact `/reset` is handled by the bridge as a control message: Matrix receives the fixed acknowledgement, ACP never receives `/reset` as a prompt, and the next ordinary prompt uses a fresh ACP session.
