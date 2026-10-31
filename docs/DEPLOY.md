# Run Vogi as a Hugging Face Space

The Space runs the same code as a laptop, in Docker. The API key is a Space secret, so the
browser never sees it. With `VOGI_ACCESS_CODE` set, every `/api` call needs that code. Two limits
protect the credits: 60 model calls per visitor per hour and 400 per day in total.

## Steps (about 15 minutes)

1. On huggingface.co, create a new Space: name `vogi`, SDK **Docker**, template **Blank**, visibility **Public**.
2. In the Space, open Settings, then "Variables and secrets". Add two secrets:
   - `MODEL_API_KEY`: the Meta Model API key.
   - `VOGI_ACCESS_CODE`: a code of your choice. Put it in the hackathon submission for the judges.
3. Optional variables: `VOGI_HOURLY_LIMIT` (default 60) and `VOGI_DAILY_LIMIT` (default 400).
4. Push the code to the Space from this folder:
   ```bash
   git remote add space https://huggingface.co/spaces/<your-user>/vogi
   git push space main
   ```
   Git asks for a password: use a Hugging Face access token with write rights.
5. Wait for the build (a few minutes), open the Space, enter the code, and check one text.

Also set a spend limit on the Meta Billing page. It is the last guard if a limit fails.

## Test the container locally

```bash
podman build -t vogi .
podman run --rm -p 127.0.0.1:7860:7860 --env-file ~/.config/vogi/env -e VOGI_ACCESS_CODE=test vogi
```
