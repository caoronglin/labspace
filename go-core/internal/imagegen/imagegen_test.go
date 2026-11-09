package imagegen

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/png"
	"testing"
)

type pol struct {
	deny    string
	revoked bool
	count   int
}

func (p *pol) Can(_ context.Context, t, u, r, a string) (bool, error) {
	p.count++
	return t == "lab" && u == "u" && r == "folder" && a != p.deny && !(p.revoked && a == "write"), nil
}

type generator struct {
	p *pol
	n int
}

func (g *generator) Generate(_ context.Context, _, _, _ string) ([]byte, error) {
	g.n++
	if g.p != nil {
		g.p.revoked = true
	}
	im := image.NewRGBA(image.Rect(0, 0, 1, 1))
	im.Set(0, 0, color.White)
	var b bytes.Buffer
	png.Encode(&b, im)
	return b.Bytes(), nil
}

type blob struct{ objects map[string][]byte }

func (b *blob) Put(_ context.Context, t, k string, data []byte) error {
	if b.objects == nil {
		b.objects = map[string][]byte{}
	}
	b.objects[k] = append([]byte{}, data...)
	return nil
}

type keyResolver struct{}

func (keyResolver) Key(_ context.Context, t, u, p string) (string, error) {
	if t != "lab" || u != "u" {
		return "", errors.New("missing")
	}
	return "personal-secret", nil
}
func TestGenerateAndRevoke(t *testing.T) {
	p := &pol{}
	g := &generator{}
	b := &blob{}
	s := New(p, g, b, keyResolver{})
	req := Request{TenantID: "lab", UserID: "u", FolderID: "folder", Prompt: "draw maize", Model: "test", Provider: "test", IdempotencyKey: "1"}
	v, e := s.Generate(context.Background(), req)
	if e != nil || v.Status != "stored" || len(b.objects) != 1 {
		t.Fatal(v, e)
	}
	again, e := s.Generate(context.Background(), req)
	if e != nil || !again.Reused || g.n != 1 {
		t.Fatal(again, e)
	}
	p2 := &pol{}
	g2 := &generator{p: p2}
	s2 := New(p2, g2, &blob{}, keyResolver{})
	_, e = s2.Generate(context.Background(), req)
	if e == nil {
		t.Fatal("revoked permissions must reject result")
	}
	p3 := &pol{deny: "send_external"}
	s3 := New(p3, &generator{}, &blob{}, keyResolver{})
	_, e = s3.Generate(context.Background(), req)
	if e == nil {
		t.Fatal("egress without permission")
	}
}
