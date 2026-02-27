#!/usr/bin/env liquidsoap

settings.init.allow_root := true
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
# HARD TECHNO CROSSFADE — kick to kick
# ============================================

def pro_mix(old, new) =
  log("MIX PRO: transition starting")

  # Equal-power (sin) curves: constant energy sum,
  # no volume dip at transition midpoint.
  # Old track holds longer — fades out over 6s,
  # new track fades in smoothly over 12s.
  old_faded = fade.out(
    duration = 6.0,
    type = "sin",
    old.source
  )

  new_faded = fade.in(
    duration = 12.0,
    type = "sin",
    new.source
  )

  mixed = add(normalize = false, [old_faded, new_faded])

  # Compressor on mix — glues kicks together, prevents dip
  compress(
    threshold = -14.0,
    ratio = 3.0,
    attack = 5.0,
    release = 100.0,
    mixed
  )
end

# 12s transition window
radio = cross(duration = 12.0, pro_mix, src)
radio = mksafe(radio)

# Master processing
processed = normalize(target = -14.0, gain_max = 3.0, gain_min = -3.0, radio)
processed = compress(threshold = -18.0, ratio = 3.0, attack = 5.0, release = 150.0, processed)
processed = mksafe(processed)
processed = limit(threshold = -1.0, attack = 0.5, release = 80.0, processed)

output.icecast(
  %ffmpeg(format="adts", %audio(codec="aac", b="256k", ar=48000, channels=2)),
  host = "icecast", port = 8000, password = "hackme", mount = "/live",
  name = "STUDIO 23", genre = "Hard Techno", description = "STUDIO 23 AutoDJ",
  processed
)
