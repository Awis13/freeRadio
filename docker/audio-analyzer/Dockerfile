# Pinned 2026-08-02 to the same digest as the audio-analyzer service in
# docker-compose.yml. mtgupf/essentia publishes no versioned tag matching
# latest, so a digest is the only pin available. See that file for the method.
FROM mtgupf/essentia@sha256:9dd13650cb5fd3aac96d10c152ba1b440a1778705cca017df5c5f651e4765953

# rubberband for BPM normalization (time-stretch without quality loss)
RUN apt-get update -qq &&     apt-get install -y --no-install-recommends rubberband-cli &&     rm -rf /var/lib/apt/lists/*

ENTRYPOINT ["python3"]
