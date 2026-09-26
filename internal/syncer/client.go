package syncer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"time"
)

type Client struct {
	Base     string
	HTTP     *http.Client
	Token    string
	Local    bool
	Requests int
}

func NewClient(raw string) (*Client, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	local := u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1")
	if (!local && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return nil, errors.New("URL must be an HTTPS origin (HTTP loopback is allowed for development)")
	}
	return &Client{Base: strings.TrimRight(raw, "/"), Local: local, HTTP: &http.Client{Timeout: 60 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

func (c *Client) Login(ctx context.Context) error {
	if c.Local {
		return nil
	}
	command := exec.CommandContext(ctx, "cloudflared", "access", "login", c.Base)
	command.Stdin = os.Stdin
	command.Stderr = os.Stderr
	// cloudflared prints the token to stdout. Keep it out of terminal logs.
	if err := command.Run(); err != nil {
		return fmt.Errorf("cloudflared login: %w", err)
	}
	output, err := exec.CommandContext(ctx, "cloudflared", "access", "token", "--app="+c.Base).Output()
	if err != nil {
		return errors.New("access token unavailable after login")
	}
	c.Token = strings.TrimSpace(string(output))
	return nil
}

func (c *Client) request(ctx context.Context, method, path string, body []byte) ([]byte, error) {
	if !c.Local && c.Token == "" {
		return nil, fmt.Errorf("%w: token unavailable; run configure", ErrAuthentication)
	}
	if expiry, ok := TokenExpiry(c.Token); !c.Local && ok && !expiry.After(time.Now()) {
		return nil, fmt.Errorf("%w: token expired at %s; run configure or login", ErrAuthentication, expiry.Format(time.RFC3339))
	}
	req, err := http.NewRequestWithContext(ctx, method, c.Base+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.Token != "" {
		req.Header.Set("cf-access-token", c.Token)
	}
	c.Requests++
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden || (res.StatusCode >= 300 && res.StatusCode < 400) {
		return nil, fmt.Errorf("%w: token expired, revoked, or rejected by policy; run configure or login", ErrAuthentication)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, 2*1024*1024+1))
	if err != nil {
		return nil, err
	}
	if len(data) > 2*1024*1024 {
		return nil, errors.New("response exceeds 2 MiB")
	}
	if res.StatusCode >= 400 {
		return nil, fmt.Errorf("server returned %d: %s", res.StatusCode, string(data))
	}
	if !strings.Contains(res.Header.Get("Content-Type"), "application/json") {
		return nil, errors.New("expected JSON; check the Access login and Worker URL")
	}
	return data, nil
}

func (c *Client) Get(ctx context.Context, path string) ([]byte, error) {
	return c.request(ctx, http.MethodGet, path, nil)
}

func (c *Client) Send(ctx context.Context, input Update) error {
	body, err := json.Marshal(input)
	if err != nil {
		return err
	}
	_, err = c.request(ctx, http.MethodPost, "/api/v1/sync", body)
	return err
}

func (c *Client) DeleteDevice(ctx context.Context, device string) error {
	_, err := c.request(ctx, http.MethodDelete, "/api/v1/devices/"+url.PathEscape(device), nil)
	return err
}

func (c *Client) DeleteSession(ctx context.Context, s Session) error {
	_, err := c.request(ctx, http.MethodDelete, "/api/v1/sessions/"+url.PathEscape(s.Device)+"/"+url.PathEscape(s.Source)+"/"+url.PathEscape(s.SourceID), nil)
	return err
}
