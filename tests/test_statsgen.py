import json
import sys


def make_manifest(tmp_path, paths):
    manifest = {"categories": [{"name": "calm", "count": len(paths), "files": [{"path": path} for path in paths]}]}
    target = tmp_path / "manifest.json"
    target.write_text(json.dumps(manifest))
    return target


def make_config(tmp_path, manifest_path, **overrides):
    values = {
        "goatcounter": "example.goatcounter.com",
        "stats_prefix": "/walls",
        "stats_days": "365",
        "stats_top": "60",
        "stats_batch": "2",
        "site_url": "https://example.test",
    }
    values.update(overrides)
    body = "[DEFAULT]\n\n[site]\n" + f"manifest = {manifest_path}\n"
    body += "".join(f"{key} = {value}\n" for key, value in values.items())
    target = tmp_path / "config.ini"
    target.write_text(body)
    return target


def run_main(statsgen, monkeypatch, config, out, *extra):
    monkeypatch.setattr(sys, "argv", ["statsgen", "--config", str(config), "--out", str(out), *extra])
    statsgen.main()


def test_tracked_paths_lowercases_keys(statsgen, tmp_path):
    manifest = make_manifest(tmp_path, ["calm/UPPER.JPG", "cherry/b.jpg"])
    assert statsgen.tracked_paths(manifest, "/walls") == {
        "/walls/w/calm/upper.jpg": "calm/UPPER.JPG",
        "/walls/w/cherry/b.jpg": "cherry/b.jpg",
    }


def test_main_batches_and_filters_hits(statsgen, tmp_path, monkeypatch):
    paths = ["calm/a.jpg", "calm/b.jpg", "calm/c.jpg", "cherry/d.jpg", "cherry/e.jpg"]
    manifest = make_manifest(tmp_path, paths)
    config = make_config(tmp_path, manifest)
    out = tmp_path / "stats.json"
    monkeypatch.setenv("GOATCOUNTER_TOKEN", "token")
    monkeypatch.setattr(statsgen, "previous_stats", lambda url: None)

    calls = []

    def fake_fetch(api, token, query):
        calls.append(query)
        hits = [{"path": path, "count": index + 1, "event": False} for index, path in enumerate(query["include_paths"])]
        hits.append({"path": "/walls/w/not/tracked.jpg", "count": 100, "event": False})
        hits.append({"path": query["include_paths"][0], "count": 50, "event": True})
        return {"hits": hits}

    monkeypatch.setattr(statsgen, "fetch_page", fake_fetch)
    run_main(statsgen, monkeypatch, config, out)

    assert [len(call["include_paths"]) for call in calls] == [2, 2, 1]
    assert all(call["path_by_name"] == "true" for call in calls)
    assert all(call["limit"] == str(statsgen.PER_PAGE) for call in calls)
    data = json.loads(out.read_text())
    assert set(data) == set(paths)
    assert data["calm/a.jpg"] == 1
    assert all(count > 0 for count in data.values())


def test_main_restores_previous_on_api_error(statsgen, tmp_path, monkeypatch):
    manifest = make_manifest(tmp_path, ["calm/a.jpg"])
    config = make_config(tmp_path, manifest)
    out = tmp_path / "stats.json"
    out.write_text("{}\n")
    monkeypatch.setenv("GOATCOUNTER_TOKEN", "token")
    monkeypatch.setattr(statsgen, "fetch_page", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("boom")))
    monkeypatch.setattr(statsgen, "previous_stats", lambda url: {"calm/old.jpg": 7})
    run_main(statsgen, monkeypatch, config, out)
    assert json.loads(out.read_text()) == {"calm/old.jpg": 7}


def test_main_dry_has_no_side_effects(statsgen, tmp_path, monkeypatch):
    manifest = make_manifest(tmp_path, ["calm/a.jpg"])
    config = make_config(tmp_path, manifest)
    out = tmp_path / "stats.json"
    out.write_text("{}\n")
    monkeypatch.setenv("GOATCOUNTER_TOKEN", "token")
    monkeypatch.setattr(statsgen, "fetch_page", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("boom")))
    restored = []
    monkeypatch.setattr(statsgen, "previous_stats", lambda url: restored.append(url) or {"x": 1})
    run_main(statsgen, monkeypatch, config, out, "--dry")
    assert out.read_text().strip() == "{}"
    assert restored == []


def test_main_keeps_existing_when_no_visits(statsgen, tmp_path, monkeypatch):
    manifest = make_manifest(tmp_path, ["calm/a.jpg"])
    config = make_config(tmp_path, manifest)
    out = tmp_path / "stats.json"
    out.write_text("{}\n")
    monkeypatch.setenv("GOATCOUNTER_TOKEN", "token")
    monkeypatch.setattr(statsgen, "fetch_page", lambda *args, **kwargs: {"hits": []})
    monkeypatch.setattr(statsgen, "previous_stats", lambda url: {"calm/kept.jpg": 3})
    run_main(statsgen, monkeypatch, config, out)
    assert json.loads(out.read_text()) == {"calm/kept.jpg": 3}


def test_main_missing_token_restores_previous(statsgen, tmp_path, monkeypatch):
    manifest = make_manifest(tmp_path, ["calm/a.jpg"])
    config = make_config(tmp_path, manifest)
    out = tmp_path / "stats.json"
    out.write_text("{}\n")
    monkeypatch.delenv("GOATCOUNTER_TOKEN", raising=False)
    monkeypatch.setattr(statsgen, "previous_stats", lambda url: {"cherry/kept.jpg": 4})
    run_main(statsgen, monkeypatch, config, out)
    assert json.loads(out.read_text()) == {"cherry/kept.jpg": 4}


def test_restore_previous_skips_nonempty(statsgen, tmp_path, monkeypatch):
    out = tmp_path / "stats.json"
    out.write_text(json.dumps({"calm/a.jpg": 1}))
    calls = []
    monkeypatch.setattr(statsgen, "previous_stats", lambda url: calls.append(url) or {"x": 2})
    statsgen.restore_previous(out, "https://example.test")
    assert json.loads(out.read_text()) == {"calm/a.jpg": 1}
    assert calls == []
