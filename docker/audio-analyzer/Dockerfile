FROM mtgupf/essentia:latest

# rubberband для BPM-нормализации (time-stretch без потери качества)
RUN apt-get update -qq &&     apt-get install -y --no-install-recommends rubberband-cli &&     rm -rf /var/lib/apt/lists/*

ENTRYPOINT ["python3"]
