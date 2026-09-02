# Tabframe MicroVM image (design §11.3): one image, two roles, chosen by the run-hook payload.
# The bundle main.js is produced by `mise run build:image`; this directory ships a placeholder
# until then so the image builds and answers its hooks.
FROM public.ecr.aws/lambda/microvms:al2023-minimal
RUN dnf install -y nodejs22 && dnf clean all
WORKDIR /app
COPY main.js /app/main.js
COPY programs/ /app/programs/
EXPOSE 8080 8081
CMD ["node", "/app/main.js"]
