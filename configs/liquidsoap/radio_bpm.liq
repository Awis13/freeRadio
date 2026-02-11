#!/usr/bin/env liquidsoap

# ============================================
#  SYSTEM 23 — Hard Techno AutoDJ (Live Mode)
#  Liquidsoap 2.3.x
#
#  LIVE: кидаешь треки в /music →
#  плейлист обновится через 30 сек,
#  BPM-карта перечитывается перед каждым переходом.
# ============================================

# --- Logging ---
settings.log.level := 3
settings.log.stdout := true

# --- Audio ---
settings.frame.audio.samplerate := 44100
settings.frame.audio.channels := 2


# ============================================
#  1. SOURCE — Живой рандомный плейлист
#
#  reload=30 — каждые 30 сек проверяет папку
#  на новые/удалённые файлы.
#  Кинул трек → через 30 сек он в ротации.
# ============================================

music = playlist(
  mode = "randomize",
  reload = 30,
  reload_mode = "rounds",
  "/music"
)

# Fallback: тишина, если /music пуста
safety = blank(duration = 1.0)
source = fallback(track_sensitive = false, [music, safety])

# --- Metadata tracking для HTTP API ---
current_title = ref("")
current_filename = ref("")

source = source.on_metadata(source, fun(m) -> begin
  current_title := m["title"] ?? ""
  current_filename := m["filename"] ?? ""
end)

# --- HTTP metadata endpoint (port 7000) ---
settings.harbor.bind_addrs := ["0.0.0.0"]

harbor.http.register(port=7000, method="GET", "/metadata", fun(~protocol, ~data, ~headers, uri) -> begin
  http.response(
    status_code=200,
    headers=[("content-type", "application/json"), ("access-control-allow-origin", "*")],
    data='{"title": "#{!current_title}", "filename": "#{!current_filename}"}'
  )
end)


# ============================================
#  2. ПЕРЕХОДЫ — Как в DJ-микстейпе
#
#  BPM-карта перечитывается КАЖДЫЙ переход
#  (не один раз при старте). Так новые треки,
#  просканированные BPM-демоном, сразу
#  получают умные переходы.
#
#  При 160 BPM:
#    1 бар  = 4 удара = 1.5 сек
#    8 баров  = 12 сек
#    16 баров = 24 сек  ← основной переход
# ============================================

# -- Читаем BPM-карту свежую с диска --
def read_bpm_map() =
  if file.exists("/music/.bpm_map") then
    file.lines("/music/.bpm_map")
  else
    []
  end
end

def get_bpm(metadata) =
  filename = metadata["filename"] ?? ""
  lines = read_bpm_map()
  result = ref(0.0)
  list.iter(fun(line) ->
    parts = string.split(separator = "\\|", line)
    if list.length(parts) >= 2 then
      path = list.nth(parts, 0)
      bpm_str = list.nth(parts, 1)
      if string.contains(substring = path, filename) or
         string.contains(substring = filename, path) then
        result := float_of_string(bpm_str ?? "0.0")
      end
    end
  , lines)
  !result
end

# -- Кастомная функция перехода --
def dj_transition(old_track, new_track) =
  bpm_old = get_bpm(old_track.metadata)
  bpm_new = get_bpm(new_track.metadata)

  old_title = old_track.metadata["filename"] ?? "???"
  new_title = new_track.metadata["filename"] ?? "???"

  log("TRANSITION: #{old_title} (#{bpm_old} BPM) -> #{new_title} (#{bpm_new} BPM)")

  if bpm_old > 0.0 and bpm_new > 0.0 then
    bpm_diff = abs(bpm_old - bpm_new)

    if bpm_diff <= 5.0 then
      # Близкий BPM — длинный микс (16 баров)
      log("  -> LONG MIX (BPM diff: #{bpm_diff})")
      add(
        normalize = false,
        [
          fade.out(duration = 20.0, old_track.source),
          fade.in(duration = 20.0, new_track.source)
        ]
      )
    elsif bpm_diff <= 10.0 then
      # Средний разброс — средний микс (8 баров)
      log("  -> MEDIUM MIX (BPM diff: #{bpm_diff})")
      add(
        normalize = false,
        [
          fade.out(duration = 10.0, old_track.source),
          fade.in(duration = 10.0, new_track.source)
        ]
      )
    else
      # Далёкий BPM — быстрый переход
      log("  -> QUICK CUT (BPM diff: #{bpm_diff})")
      add(
        normalize = false,
        [
          fade.out(duration = 3.0, old_track.source),
          fade.in(duration = 3.0, new_track.source)
        ]
      )
    end
  else
    # Нет BPM-данных — дефолтный длинный микс
    log("  -> DEFAULT LONG MIX (no BPM data)")
    add(
      normalize = false,
      [
        fade.out(duration = 16.0, old_track.source),
        fade.in(duration = 16.0, new_track.source)
      ]
    )
  end
end

# Применяем кастомный переход
radio = cross(
  duration = 24.0,
  minimum = 8.0,
  dj_transition,
  source
)


# ============================================
#  3. AUDIO PROCESSING
#
#  normalize → compress → limit
#  Плотный громкий звук без клиппинга.
# ============================================

processed = normalize(
  target = -14.0,
  gain_max = 3.0,
  gain_min = -3.0,
  radio
)

processed = compress(
  threshold = -18.0,
  ratio = 3.0,
  attack = 5.0,
  release = 150.0,
  processed
)

processed = limit(
  threshold = -1.0,
  attack = 0.5,
  release = 80.0,
  processed
)


# ============================================
#  4. OUTPUT — Icecast (MP3 320kbps)
# ============================================

output.icecast(
  %mp3(
    bitrate = 320,
    samplerate = 44100,
    stereo = true,
    id3v2 = true
  ),
  host = "icecast",
  port = 8000,
  password = "hackme",
  mount = "/live",
  name = "SYSTEM 23",
  genre = "Hard Techno",
  description = "SYSTEM 23 — Hard Techno AutoDJ — 160+ BPM",
  processed
)
