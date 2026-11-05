# The Sandbox image a LayerFS mount runs: the layerfs-daemon of the pinned
# LayerFS commit, on a runtime base that satisfies it.
#
# LayerFS creates each Sandbox as an unprivileged container - CAP_SYS_ADMIN and
# /dev/fuse for the FUSE mount, the Store as a named volume at /layerfs-store,
# one port published on 127.0.0.1 - whose entrypoint is
# /usr/local/bin/layerfs-daemon --config /layerfs-local/config/daemon.setup.
# Before it starts the container the SDK uploads its own host-built daemon
# (LAYERFS_DAEMON, the binary .agents/setup builds) over that path, so the copy
# this image carries is the same build from the same commit: it keeps the image
# self-contained and startable on its own, and it is what runs when a
# deployment points LAYERFS_DAEMON at nothing else.
#
# Build from the repository root:
#
#   docker build -f packages/workspace-layerfs/sandbox.Dockerfile \
#     --build-arg LAYERFS_COMMIT=67310175ebba2b84efefb4df76f875a43487cf50 \
#     -t arbor-layerfs-sandbox .
#
# Then read the digest the build pushed (`docker images --digests`) and set
# LAYERFS_IMAGE to it: a Sandbox mounts with an exact digest, never a tag. The
# build needs network access: it clones LayerFS and fetches crates.

# The pinned LayerFS commit .agents/setup builds the addon and daemon from.
ARG LAYERFS_COMMIT=67310175ebba2b84efefb4df76f875a43487cf50
# The toolchain the pinned commit builds with (its Cargo.toml: rust-version 1.85).
ARG RUST_VERSION=1.85.1
# The runtime base. The daemon the SDK uploads runs here, so the base's glibc
# must be at least what the host build linked against. Check the host build
# with:
#   objdump -T .layerfs/target/release/layerfs-daemon | grep -o 'GLIBC_[0-9.]*' | sort -uV
# debian:trixie carries glibc 2.41 and covers the current host build (2.39);
# a host on a newer glibc needs a newer base here.
ARG BASE_IMAGE=debian:trixie-slim

FROM rust:${RUST_VERSION}-bookworm AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ARG LAYERFS_COMMIT
WORKDIR /layerfs
RUN git init -q . \
  && git remote add origin https://github.com/Ephemeral-AI-Lab/layerfs.git \
  && git fetch -q --depth 1 origin "$LAYERFS_COMMIT" \
  && git checkout -q --detach FETCH_HEAD \
  && test "$(git rev-parse HEAD)" = "$LAYERFS_COMMIT"

# Only the daemon: layerfs-node is a host library the SDK loads in its own
# process, and the image never needs it. The workspace's vendored fuser and
# locked Cargo.lock come with the checkout, so this is a --locked build.
RUN cargo build -q --locked --release --manifest-path Cargo.toml -p layerfs-daemon

FROM ${BASE_IMAGE}

# What the daemon needs at runtime, and nothing else:
# - a C runtime: the binary links glibc, libm and libgcc_s;
# - bash, findutils and grep: the SDK's exec runs every workspace command
#   through `bash -c`, and the file tools list, find and grep through it, so
#   the image carries the commands an agent's `bash` call expects. debian-slim
#   ships dash and coreutils, so bash, findutils and grep are added;
# - SQLite is compiled into the binary (rusqlite bundled on Linux), so there
#   are no headers or libraries to add;
# - no fusermount: the daemon mounts FUSE itself through the /dev/fuse device
#   and the CAP_SYS_ADMIN the Engine gives the container.
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash findutils grep libgcc-s1 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /layerfs/target/release/layerfs-daemon /usr/local/bin/layerfs-daemon
RUN chmod 0755 /usr/local/bin/layerfs-daemon

# Not baked in: the SDK uploads /layerfs-local (its config and overlay) and
# /workspaces (the mount root) into the stopped container, and the Store
# arrives as the named volume at /layerfs-store.
