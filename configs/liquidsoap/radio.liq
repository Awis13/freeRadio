#!/usr/bin/env liquidsoap

settings.log.level := 3
settings.log.stdout := true
settings.frame.audio.samplerate := 44100
settings.frame.audio.channels := 2

music = playlist(mode = "randomize", reload = 1, reload_mode = "rounds", "/music")

def write_track(m) =
  file.write(data=m["filename"], "/shared/current_audio.txt")
end
music = source.on_metadata(music, write_track)

safety = blank(duration = 1.0)
src = fallback(track_sensitive = false, [music, safety])
src = mksafe(src)

# ============================================
# PRO DJ CROSSFADE (longer, smoother blend)
# ============================================

def pro_mix(old, new) =
  log("MIX PRO: transition starting")

  # Longer overlap than before:
  # - old track fades out for 14s
  # - new track fades in for 12s
  old_faded = fade.out(
    duration = 14.0,
    type = "log",
    old.source
  )

  new_faded = fade.in(
    duration = 12.0,
    type = "log",
    new.source
  )

  add(normalize = false, [old_faded, new_faded])
end

# Wider cross window for more "mix" feeling.
radio = cross(duration = 16.0, pro_mix, src)
radio = mksafe(radio)

# Master processing
processed = normalize(target = -14.0, gain_max = 3.0, gain_min = -3.0, radio)
processed = compress(threshold = -18.0, ratio = 3.0, attack = 5.0, release = 150.0, processed)
processed = mksafe(processed)
processed = limit(threshold = -1.0, attack = 0.5, release = 80.0, processed)

output.icecast(
  %mp3(bitrate = 320, samplerate = 44100, stereo = true, id3v2 = true),
  host = "icecast", port = 8000, password = "hackme", mount = "/live",
  name = "SYSTEM 23", genre = "Hard Techno", description = "SYSTEM 23 AutoDJ",
  processed
)
