# Tabframe MicroVM image (design §11.3): one image, two roles, chosen by the run-hook payload.
# The bundle main.js is produced by `mise run build:image`; this directory ships a placeholder
# until then so the image builds and answers its hooks.
# Pinned by digest (WP8.2): two builds of one commit get the same base. Refresh the digest with
# `docker buildx imagetools inspect public.ecr.aws/lambda/microvms:al2023-minimal`.
FROM public.ecr.aws/lambda/microvms:al2023-minimal@sha256:05cb9b38d841e7ff1b693dc9e894909612f340bf99ec97d426e8000a5bbe96c3
RUN dnf install -y nodejs22 && dnf clean all && node --version
WORKDIR /app
COPY package.json /app/package.json
COPY main.js /app/main.js
COPY node-worker.js /app/node-worker.js
COPY programs/ /app/programs/
# The build stamp (WP8.1, shipped since WP8.2): /health names the commit the image was staged from.
COPY build.json /app/build.json
EXPOSE 8080 8081
CMD ["node", "/app/main.js"]
