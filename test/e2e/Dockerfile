FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    gnome-shell \
    gjs \
    xvfb \
    dbus-x11 \
    dbus \
    elogind \
    at-spi2-core \
    libgl1-mesa-dri \
    libglx-mesa0 \
    unzip \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -ms /bin/bash tester && \
    mkdir -p /tmp/runtime-tester && \
    chown tester:tester /tmp/runtime-tester && \
    chmod 700 /tmp/runtime-tester && \
    mkdir -p /tmp/.X11-unix && \
    chmod 1777 /tmp/.X11-unix

COPY run-test.sh /run-test.sh
RUN chmod +x /run-test.sh

USER tester
ENV HOME=/home/tester
ENV XDG_RUNTIME_DIR=/tmp/runtime-tester
ENV NO_AT_BRIDGE=1
WORKDIR /home/tester
