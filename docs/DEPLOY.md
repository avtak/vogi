# Run Vogi as a Hugging Face Space

Live: https://avtak-vogi.hf.space (Docker SDK on **CPU upgrade**, $0.03 an hour while awake,
sleeps after 15 minutes without visitors). The Space builds the `Dockerfile`. Free CPU Basic needs
a PRO account, and ZeroGPU runs only Gradio apps with a `@spaces.GPU` function (31.10.2026).

The API key is a Space secret, so the browser never sees it. With `VOGI_ACCESS_CODE` set, every
`/api` call needs that code. Two limits protect the credits: 60 model calls per visitor per hour
and 400 per day in total.

## Steps (about 15 minutes)

1. On huggingface.co/new-space: name `vogi`, license `mit`, SDK **Docker**, template **Blank**,
   hardware **Custom Hardware: CPU upgrade**, sleep after 15 minutes, visibility **Public**.
2. In the Space, open Settings, then "Variables and secrets". Add two secrets:
   - `MODEL_API_KEY`: the Meta Model API key.
   - `VOGI_ACCESS_CODE`: a code of your choice. Put it in the hackathon submission for the judges.
3. Optional variables: `VOGI_HOURLY_LIMIT` (default 60) and `VOGI_DAILY_LIMIT` (default 400).
4. Push the code from this folder. The new Space has one starter commit (its README), and this
   push replaces it:
   ```bash
   git remote add space https://huggingface.co/spaces/<your-user>/vogi
   git push --force space main
   ```
   Git asks for a username and a password: use a Hugging Face access token with write rights.
5. Wait for the build (about two minutes), open the Space, enter the code, and check one text.

**Binary files:** the Space repo takes no binary files, so it never gets `vogi/static/scenes/*.webp`.
The Space builds from a local branch `space-main` that has the same code without them, and the
server downloads the pictures from the GitHub repo at start. To deploy a new commit from `main`:

```bash
git checkout space-main && git cherry-pick <commit> && git checkout main
git push space space-main:main
```

Also set a spend limit on the Meta Billing page. It is the last guard if a limit fails.

## Other hosts

`Dockerfile` runs the same app on any Docker host (port 7860).

## Test the container locally

```bash
podman build -t vogi .
podman run --rm -p 127.0.0.1:7860:7860 --env-file ~/.config/vogi/env -e VOGI_ACCESS_CODE=test vogi
```
