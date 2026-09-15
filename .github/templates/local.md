## Running locally

The gallery is a static site. Generate the manifest, then serve the repository root:

```sh
# Scan local image folders and write site/manifest.json
python3 ./.github/sitegen.py --local

# Serve the repo root, then open http://localhost:8000/site/
python3 -m http.server 8000
```
