# syntax=docker/dockerfile:1

# The Discogs MCP server, installed once at build time.
#
# It used to run as `npx -y discogs-mcp-server` on a stock node image, which
# fails on a clean container: the package depends on dotenv by git URL
# (`github:cswkim/dotenv`), so npm shells out to git, and node:20-*-slim has no
# git binary. The container died with `spawn git ENOENT` on every start, and
# the app reported "Discogs tools unavailable: fetch failed" — a failure two
# hops away from its cause.
#
# Installing at build time fixes more than that. npx re-resolved the package on
# every boot, so a NAS reboot with slow or unavailable internet meant no chat
# tools, and the running version could change underneath you without anything
# being edited.
FROM node:20-bookworm-slim

# git is required to resolve the dotenv dependency; ca-certificates for the
# HTTPS clone. Both are build-time needs, but the image is small enough that
# stripping them afterwards is not worth a second stage.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Pinned: a boot should never quietly pick up a different version.
ARG MCP_VERSION=0.5.7
RUN npm install -g "discogs-mcp-server@${MCP_VERSION}" && npm cache clean --force

USER node

ENV PORT=3001 \
    SERVER_HOST=0.0.0.0

EXPOSE 3001

# 'stream' is the HTTP transport; the default, 'stdio', would expect a parent
# process on the other end of a pipe rather than a peer over the network.
CMD ["discogs-mcp-server", "stream"]
