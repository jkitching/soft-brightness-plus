FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    gnome-shell \
    gjs \
    xvfb \
    dbus-x11 \
    dbus \
    at-spi2-core \
    xdotool \
    imagemagick \
    python3 \
    python3-pyatspi \
    libgl1-mesa-dri \
    libglx-mesa0 \
    unzip \
    librsvg2-common \
    adwaita-icon-theme \
    && rm -rf /var/lib/apt/lists/*

# --no-install-recommends skips the SVG pixbuf loader wiring; without a
# rebuilt loader cache every symbolic icon renders as an empty pill.
RUN /usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/gdk-pixbuf-query-loaders --update-cache

RUN useradd -ms /bin/bash tester && \
    mkdir -p /tmp/runtime-tester /tmp/.X11-unix && \
    chown tester:tester /tmp/runtime-tester && \
    chmod 700 /tmp/runtime-tester && \
    chmod 1777 /tmp/.X11-unix

COPY run-screenshots.sh find-slider.py fake-logind.js /
RUN chmod +x /run-screenshots.sh

USER tester
ENV HOME=/home/tester
ENV XDG_RUNTIME_DIR=/tmp/runtime-tester
WORKDIR /home/tester
