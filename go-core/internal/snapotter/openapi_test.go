package snapotter

import "testing"

// The sample mirrors the real SnapOtter OpenAPI layout (2 space indent per
// level, operation keys at 6 spaces, request body properties at 16/18).
const sample = `openapi: 3.0.0
paths:
  /api/v1/health:
    get:
      summary: Health
  /api/v1/tools/image/resize:
    post:
      operationId: resizeImage
      tags: [Tools]
      summary: Resize Image
      description: Resize an image to specific dimensions.
      requestBody:
        required: true
        content:
          multipart/form-data:
            schema:
              type: object
              required: [file]
              properties:
                file:
                  type: string
                  format: binary
                  description: Image file to process
                settings:
                  type: string
                  description: |
                    JSON string with options:
                    - ` + "`width`" + ` (number, optional)
  /api/v1/tools/pdf/compress:
    post:
      operationId: compressPdf
      summary: Compress PDF
      description: Reduce the size of a PDF file.
      requestBody:
        content:
          multipart/form-data:
            schema:
              properties:
                file:
                  type: string
                  format: binary
                  description: PDF file to process
`

func TestParseOpenAPI(t *testing.T) {
	tools := ParseOpenAPI(sample)
	if len(tools) != 2 {
		t.Fatalf("expected 2 tools, got %d: %+v", len(tools), tools)
	}
	if tools[0].Section != "image" || tools[0].ID != "resize" {
		t.Fatalf("unexpected tool identity: %+v", tools[0])
	}
	if tools[0].Name != "Resize Image" {
		t.Fatalf("unexpected tool name: %+v", tools[0])
	}
	if tools[0].Description != "Resize an image to specific dimensions." {
		t.Fatalf("unexpected description: %+v", tools[0])
	}
	if tools[0].Accept != "Image file to process" {
		t.Fatalf("unexpected accept hint: %+v", tools[0])
	}
	if tools[1].Section != "pdf" || tools[1].ID != "compress" {
		t.Fatalf("unexpected second tool: %+v", tools[1])
	}
	if tools[1].Description != "Reduce the size of a PDF file." {
		t.Fatalf("unexpected description: %+v", tools[1])
	}
	if tools[1].Accept != "PDF file to process" {
		t.Fatalf("unexpected accept hint: %+v", tools[1])
	}
}

func TestParseOpenAPISkipsBlockScalar(t *testing.T) {
	doc := `  /api/v1/tools/image/crop:
    post:
      summary: Crop Image
      description: |
        Crop an image.
        Second line of the block.
      properties:
        file:
          description: Image file
`
	tools := ParseOpenAPI(doc)
	if len(tools) != 1 {
		t.Fatalf("expected 1 tool, got %d", len(tools))
	}
	if tools[0].Description != "" {
		t.Fatalf("block scalar description must be skipped, got %q", tools[0].Description)
	}
	if tools[0].Accept != "Image file" {
		t.Fatalf("unexpected accept hint: %+v", tools[0])
	}
}

func TestParseOpenAPIEmpty(t *testing.T) {
	if tools := ParseOpenAPI("openapi: 3.0.0\npaths: {}\n"); len(tools) != 0 {
		t.Fatalf("expected no tools, got %d", len(tools))
	}
}

func TestParseOpenAPIEndsToolAtNonToolPath(t *testing.T) {
	// A path with three segments is not a tool (the Python implementation
	// skips it as well) but it must still close the previous tool block.
	doc := `  /api/v1/tools/image/html-to-image:
    post:
      summary: Capture webpage as image
      description: Capture a webpage.
  /api/v1/tools/image/strip-metadata/inspect:
    post:
      summary: Inspect metadata
      description: Read metadata.
  /api/v1/tools/image/edit-metadata:
    post:
      summary: Edit metadata
      description: Edit metadata.
`
	tools := ParseOpenAPI(doc)
	if len(tools) != 2 {
		t.Fatalf("expected 2 tools, got %d: %+v", len(tools), tools)
	}
	if tools[0].ID != "html-to-image" || tools[0].Name != "Capture webpage as image" {
		t.Fatalf("first tool got the wrong title: %+v", tools[0])
	}
	if tools[1].ID != "edit-metadata" || tools[1].Name != "Edit metadata" {
		t.Fatalf("second tool got the wrong title: %+v", tools[1])
	}
}

func TestParseOpenAPIDropsQuotes(t *testing.T) {
	doc := `  /api/v1/tools/audio/aac-to-flac:
    post:
      summary: "AAC to FLAC"
      description: 'Convert AAC to FLAC'
`
	tools := ParseOpenAPI(doc)
	if len(tools) != 1 {
		t.Fatalf("expected 1 tool, got %d", len(tools))
	}
	if tools[0].Name != "AAC to FLAC" {
		t.Fatalf("summary quotes not removed: %q", tools[0].Name)
	}
	if tools[0].Description != "Convert AAC to FLAC" {
		t.Fatalf("description quotes not removed: %q", tools[0].Description)
	}
}
