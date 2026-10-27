# ADS-B Antenna Range Visualizer: collector and viewer in one container, for
# receivers where tar1090 itself runs in docker (for example sdr-enthusiasts'
# docker-adsb-ultrafeeder). Configuration is by environment variable; see the
# Docker section of README.md, or the header of docker/entrypoint.sh.
#
#   docker build -t range3d .
FROM python:3.12-slim

LABEL org.opencontainers.image.title="range3d" \
      org.opencontainers.image.description="Altitude-resolved 3D coverage envelope for a tar1090 receiver" \
      org.opencontainers.image.source="https://github.com/Charan-N15/ADS-B-3D-Antenna-Range-Visualizer" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
COPY collector/ collector/
COPY tools/fetch-basemap.py tools/
COPY viewer/ viewer/
COPY docker/ docker/

# Map tiles are fetched at runtime into the data volume; the viewer finds them
# through this link, which keeps the image itself location-agnostic.
RUN rm -rf viewer/basemap \
 && ln -s /data/basemap viewer/basemap \
 && chmod 0755 docker/entrypoint.sh

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# envelope.json (the collected record, irreplaceable) and basemap/ (re-fetchable).
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/', timeout=4)"

# Starts as root only long enough to chown /data, then drops to PUID:PGID.
ENTRYPOINT ["/app/docker/entrypoint.sh"]
