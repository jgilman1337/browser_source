#!/bin/sh
set -e

CONFIG_PATH="${CONFIG_PATH:-/app/config.json}"
RUN_TS="$(dirname "$0")/run-ts.sh"
STREAMER_RUNTIME="${STREAMER_RUNTIME:-node}"
export STREAMER_RUNTIME

echo "[entrypoint] runtime: ${STREAMER_RUNTIME}" >&2
case "${STREAMER_RUNTIME}" in
	node)
		echo "[entrypoint] node: $(node --version)" >&2
		;;
	bun)
		echo "[entrypoint] bun: $(bun --version)" >&2
		;;
esac
echo "[entrypoint] config: ${CONFIG_PATH}" >&2

# Start X on one idle DRM card. Returns 0 only when kmsgrab can read a frame from it.
start_gpu_display() {
	card_dev="$1"
	card_name=$(basename "${card_dev}")
	uevent="/sys/class/drm/${card_name}/device/uevent"
	slot=$(sed -n 's/^PCI_SLOT_NAME=0000://p' "${uevent}")
	driver=$(sed -n 's/^DRIVER=//p' "${uevent}")
	# PCI_SLOT_NAME uses hex with leading zeros; dash has no bash 10# decimal syntax.
	bus_hex=$(echo "${slot}" | cut -d: -f1)
	dev_hex=$(echo "${slot}" | cut -d: -f2 | cut -d. -f1)
	fn_hex=$(echo "${slot}" | cut -d. -f2)
	bus=$(printf '%d' "0x${bus_hex}")
	dev=$(printf '%d' "0x${dev_hex}")
	fn=$(printf '%d' "0x${fn_hex}")
	xdriver="modesetting"
	if [ "${driver}" = "nvidia" ] && find /usr -path '*/drivers/nvidia_drv.so' -print -quit 2>/dev/null | grep -q .; then
		xdriver="nvidia"
	fi
	conf=/tmp/xorg-scanout.conf
	cat > "${conf}" <<EOF
Section "ServerFlags"
	Option "DontVTSwitch" "true"
	Option "AllowMouseOpenFail" "true"
	Option "AutoAddDevices" "false"
	Option "AutoEnableDevices" "false"
EndSection
Section "Device"
	Identifier "GPU"
	Driver "${xdriver}"
	BusID "PCI:${bus}:${dev}:${fn}"
	Option "AllowEmptyInitialConfiguration" "true"
EndSection
Section "Screen"
	Identifier "Screen"
	Device "GPU"
	DefaultDepth 24
EndSection
EOF
	Xorg :99 -background none -noreset -nolisten tcp \
		-config "${conf}" -logfile /tmp/xorg-scanout.log \
		-novtswitch -sharevts >/tmp/xorg-scanout.out 2>&1 &
	xpid=$!
	i=0
	while [ "${i}" -lt 30 ]; do
		if [ -S /tmp/.X11-unix/X99 ]; then
			break
		fi
		if ! kill -0 "${xpid}" 2>/dev/null; then
			echo "[entrypoint] Xorg exited before the display was ready" >&2
			tail -n 30 /tmp/xorg-scanout.log >&2 || true
			return 1
		fi
		i=$((i + 1))
		sleep 0.1
	done
	if [ ! -S /tmp/.X11-unix/X99 ]; then
		echo "[entrypoint] Xorg did not create a display" >&2
		kill "${xpid}" 2>/dev/null || true
		tail -n 30 /tmp/xorg-scanout.log >&2 || true
		return 1
	fi
	export DISPLAY=:99
	if ! "${RUN_TS}" scripts/probe-scanout.ts --frames "${card_dev}" >/dev/null 2>&1; then
		echo "[entrypoint] GPU display has no capturable plane" >&2
		kill "${xpid}" 2>/dev/null || true
		unset DISPLAY
		return 1
	fi
	return 0
}

# Chromium tab-audio capture needs an output device. Docker has no sound card — use a null sink.
PULSE_RUNTIME_PATH="${PULSE_RUNTIME_PATH:-/tmp/pulse-runtime}"
export PULSE_RUNTIME_PATH
mkdir -p "${PULSE_RUNTIME_PATH}"
rm -rf "${PULSE_RUNTIME_PATH:?}"/*
pulseaudio --kill 2>/dev/null || true

if ! pulseaudio --check 2>/dev/null; then
	echo "[entrypoint] starting PulseAudio null sink" >&2
	pulseaudio -D --exit-idle-time=-1 --disallow-exit \
		--load="module-null-sink sink_name=capture"
	sleep 1
	if ! pulseaudio --check 2>/dev/null; then
		echo "[entrypoint] PulseAudio failed to start" >&2
		exit 1
	fi
fi

SCREEN_ARGS=$("${RUN_TS}" scripts/xvfb-screen-args.ts)

echo "[entrypoint] xvfb screen: ${SCREEN_ARGS}" >&2

# A free connector on the encoder's GPU can be modeset and grabbed without a CPU copy.
# An in-use connector is left alone so this process does not capture someone else's desktop.
SCANOUT_CARD=$("${RUN_TS}" scripts/probe-scanout.ts 2>/dev/null || true)
if [ -n "${SCANOUT_CARD}" ] && start_gpu_display "${SCANOUT_CARD}"; then
	export GPU_SCANOUT_DEVICE="${SCANOUT_CARD}"
	echo "[entrypoint] GPU scanout: ${SCANOUT_CARD} on ${DISPLAY}" >&2
	exec "${RUN_TS}" src/index.ts
fi
if [ -n "${SCANOUT_CARD}" ]; then
	echo "[entrypoint] GPU display did not start; using Xvfb and tab capture" >&2
fi

exec xvfb-run --auto-servernum --server-args="-screen 0 ${SCREEN_ARGS}" "${RUN_TS}" src/index.ts
