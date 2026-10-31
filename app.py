"""Hugging Face Space entry point (Gradio SDK on ZeroGPU hardware, free for personal accounts).

Vogi itself is the FastAPI app in vogi/server.py with its own page. Gradio is only the runtime
this Space type requires: a small Gradio page is mounted at /gradio, and Vogi serves everything
else. Vogi uses no GPU: all models run on the Meta Model API.
"""

import os

import gradio as gr
import uvicorn

from vogi.server import app as vogi_app

with gr.Blocks(title="Vogi") as info:
    gr.Markdown("Vogi runs at the root of this Space: open it without `/gradio`.")

app = gr.mount_gradio_app(vogi_app, info, path="/gradio")

def _diagnose() -> None:
    """Print which processes run and which ports listen (no secrets), for the Space log."""
    names = ("PORT", "GRADIO_SERVER_PORT", "GRADIO_SERVER_NAME", "SPACES_ZERO_GPU", "SYSTEM", "SPACE_ID")
    print("env:", {k: os.environ.get(k) for k in names}, flush=True)
    for pid in sorted(p for p in os.listdir("/proc") if p.isdigit()):
        try:
            cmd = open(f"/proc/{pid}/cmdline", "rb").read().replace(b"\0", b" ").decode()[:160]
        except OSError:
            continue
        print("proc", pid, cmd, flush=True)
    try:
        for line in open("/proc/net/tcp").read().splitlines()[1:]:
            local, state = line.split()[1], line.split()[3]
            if state == "0A":
                print("listening on port", int(local.split(":")[1], 16), flush=True)
    except OSError:
        pass


if __name__ == "__main__":
    _diagnose()
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "7860")))
