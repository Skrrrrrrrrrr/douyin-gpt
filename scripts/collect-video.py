"""Extract timestamped evidence from an already collected local public video."""
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont
import imageio_ffmpeg


def run(ffmpeg, args, quiet=True):
    command = [ffmpeg, "-hide_banner", "-nostdin", "-y", "-protocol_whitelist", "file,pipe"]
    if quiet:
        command += ["-loglevel", "error"]
    return subprocess.run(command + args, capture_output=True, text=True, timeout=600)


def sample(ffmpeg, source, folder, at, prefix, tail=False):
    # A recording's audio can end slightly after its final variable-rate video frame.
    # Fall back only near EOF, and label the earlier sample time rather than inventing a frame.
    for delta in ([0, .25, .5, 1] if tail else [0]):
        actual = max(0, at - delta)
        name = folder / (prefix + "-" + str(round(actual * 1000)) + ".jpg")
        name.unlink(missing_ok=True)
        result = run(ffmpeg, ["-ss", str(actual), "-i", str(source), "-frames:v", "1",
                              "-vf", "scale=640:-2", "-q:v", "3", str(name)])
        if result.returncode == 0 and name.exists():
            name.chmod(0o600)
            return {"at": round(actual, 3), "file": str(name),
                    **({"requestedAt": round(at, 3), "tailFallback": True} if delta else {})}
    raise RuntimeError("FRAME_EXTRACTION_FAILED")


def sheets(frames, folder, prefix):
    outputs = []
    font = ImageFont.load_default(size=20)
    for index in range(0, len(frames), 12):
        group = frames[index:index + 12]
        canvas = Image.new("RGB", (1200, math.ceil(len(group) / 3) * 300), "#111827")
        draw = ImageDraw.Draw(canvas)
        for offset, frame in enumerate(group):
            with Image.open(frame["file"]) as image:
                image.thumbnail((394, 268))
                x, y = (offset % 3) * 400, (offset // 3) * 300
                canvas.paste(image, (x + (400 - image.width) // 2, y))
                draw.text((x + 8, y + 272), "%.2fs" % frame["at"], fill="white", font=font)
        name = folder / (prefix + "-sheet-" + str(index // 12) + ".jpg")
        canvas.save(name, quality=88)
        name.chmod(0o600)
        outputs.append(str(name))
    return outputs


def main():
    cfg = json.load(sys.stdin)
    folder = Path(cfg["folder"]).resolve()
    source = Path(cfg["source"]).resolve()
    if source.parent != folder or source.name != "video.mp4":
        raise RuntimeError("INVALID_LOCAL_VIDEO")
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    if cfg.get("mode") == "refine":
        duration = float(cfg["durationSeconds"])
        times = sorted(set(float(t) for t in cfg["times"] if 0 <= float(t) < duration))
        frames = [sample(ffmpeg, source, folder, at, "detail", at > duration - 1) for at in times]
        return {"frames": frames, "sheets": sheets(frames, folder, "detail")}

    info = run(ffmpeg, ["-i", str(source)], quiet=False).stderr
    match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", info)
    if not match and "Video:" in info:
        # MediaRecorder WebM does not write a seekable duration; remux without re-encoding.
        normalized = folder / "normalized.mkv"
        result = run(ffmpeg, ["-i", str(source), "-c", "copy", str(normalized)])
        if result.returncode == 0:
            normalized.replace(source)
            info = run(ffmpeg, ["-i", str(source)], quiet=False).stderr
            match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", info)
    if not match or "Video:" not in info:
        raise RuntimeError("INVALID_VIDEO_CONTAINER")
    duration = int(match[1]) * 3600 + int(match[2]) * 60 + float(match[3])
    if not math.isfinite(duration) or duration <= 0:
        raise RuntimeError("INVALID_VIDEO_DURATION")
    expected = float(cfg.get("expectedDurationSeconds", 0))
    if expected > 0 and duration + max(1, expected * .01) < expected:
        raise RuntimeError("MEDIA_SHORTER_THAN_SOURCE_VIDEO")
    interval = max(1, float(cfg.get("sampleIntervalSeconds", 8)))
    times = sorted(set([0.0, max(0.0, duration - .2)] +
                       [round(n * interval, 3) for n in range(1, math.ceil(duration / interval))
                        if n * interval < duration - .2]))
    frames = [sample(ffmpeg, source, folder, at, "frame", at >= duration - .25) for at in times]
    # Scene changes supplement the uniform samples; the timeline still covers both ends.
    scene_max = int(cfg.get("maxSceneFrames", 40))
    if scene_max:
        scene = run(ffmpeg, ["-i", str(source), "-vf",
                            r"select=gt(scene\,0.35),scale=640:-2,showinfo",
                            "-fps_mode", "vfr", "-frames:v", str(scene_max),
                            "-q:v", "3", str(folder / "scene-%05d.jpg")], quiet=False)
        stamps = [float(x) for x in re.findall(r"pts_time:([0-9.]+)", scene.stderr)]
        for at, path in zip(stamps, sorted(folder.glob("scene-*.jpg"))):
            if 0 <= at < duration and all(abs(at - f["at"]) > .3 for f in frames):
                path.chmod(0o600)
                frames.append({"at": round(at, 3), "file": str(path)})
    frames.sort(key=lambda f: f["at"])
    audio = {"present": "Audio:" in info, "chunks": []}
    if audio["present"]:
        result = run(ffmpeg, ["-i", str(source), "-map", "0:a:0", "-vn", "-ac", "1",
                              "-ar", "16000", "-c:a", "aac", "-b:a", "48k", "-f", "segment",
                              "-segment_time", "600", "-reset_timestamps", "1",
                              str(folder / "audio-%04d.m4a")])
        if result.returncode:
            audio["error"] = "AUDIO_EXTRACTION_FAILED"
        else:
            for n, path in enumerate(sorted(folder.glob("audio-*.m4a"))):
                path.chmod(0o600)
                audio["chunks"].append({"file": str(path), "start": n * 600,
                                         "end": min(duration, (n + 1) * 600)})
    return {"durationSeconds": duration, "frames": frames,
            "sheets": sheets(frames, folder, "overview"), "audio": audio}


if __name__ == "__main__":
    os.umask(0o077)
    try:
        print(json.dumps(main(), ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"error": str(exc) if str(exc).isupper() else type(exc).__name__}))
        sys.exit(1)
