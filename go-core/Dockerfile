FROM golang:1.23 AS build
WORKDIR /src
COPY go.mod ./
COPY . .
RUN GOPROXY=off CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/labgo ./cmd/labgo
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/labgo /usr/local/bin/labgo
USER nonroot:nonroot
EXPOSE 8122
ENTRYPOINT ["/usr/local/bin/labgo"]
