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

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "7860")))
