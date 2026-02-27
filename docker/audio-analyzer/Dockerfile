FROM mtgupf/essentia:latest

# rubberband for BPM normalization (time-stretch without quality loss)
RUN apt-get update -qq &&     apt-get install -y --no-install-recommends rubberband-cli &&     rm -rf /var/lib/apt/lists/*

ENTRYPOINT ["python3"]
