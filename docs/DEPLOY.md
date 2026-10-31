# Run Vogi as a Hugging Face Space

The Space runs the same code as a laptop. It uses the **Gradio SDK on ZeroGPU hardware**, which
free personal accounts can host (up to 2 Spaces; Hugging Face docs, 31.10.2026). `app.py` starts
Vogi's own server; Gradio is only the runtime this Space type needs, and Vogi uses no GPU.

The API key is a Space secret, so the browser never sees it. With `VOGI_ACCESS_CODE` set, every
`/api` call needs that code. Two limits protect the credits: 60 model calls per visitor per hour
and 400 per day in total.

## Steps (about 15 minutes)

1. On huggingface.co/new-space: name `vogi`, license `mit`, SDK **Gradio**, template **Blank**,
   hardware **ZeroGPU**, visibility **Public**. Create the Space.
2. In the Space, open Settings, then "Variables and secrets". Add two secrets:
   - `MODEL_API_KEY`: the Meta Model API key.
   - `VOGI_ACCESS_CODE`: a code of your choice. Put it in the hackathon submission for the judges.
3. Optional variables: `VOGI_HOURLY_LIMIT` (default 60) and `VOGI_DAILY_LIMIT` (default 400).
4. Push the code from this folder. The new Space already has one commit (its own README), and
   this push replaces it:
   ```bash
   git push --force space main
   ```
   Git asks for a username (your Hugging Face name) and a password: use a Hugging Face access
   token with write rights (Settings, Access Tokens).
5. Wait for the build (a few minutes), open the Space, enter the code, and check one text.

Also set a spend limit on the Meta Billing page. It is the last guard if a limit fails.

## Other hosts

`Dockerfile` runs the same app on any Docker host (port 7860).

## Test the container locally

```bash
podman build -t vogi .
podman run --rm -p 127.0.0.1:7860:7860 --env-file ~/.config/vogi/env -e VOGI_ACCESS_CODE=test vogi
```
