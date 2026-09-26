package syncer

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

var ErrAuthentication = errors.New("authentication failed")

// Expiry is a local diagnostic only. The Worker verifies the authenticated identity.
func TokenExpiry(token string) (time.Time, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return time.Time{}, false
	}
	data, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return time.Time{}, false
	}
	var claims struct {
		Exp int64 `json:"exp"`
	}
	if json.Unmarshal(data, &claims) != nil || claims.Exp <= 0 {
		return time.Time{}, false
	}
	return time.Unix(claims.Exp, 0), true
}

func TokenStatus(ctx context.Context, c *Client) string {
	if c.Local {
		return "development (local Access simulation)"
	}
	if c.Token == "" {
		return "invalid (missing token)"
	}
	expiry, hasExpiry := TokenExpiry(c.Token)
	if hasExpiry && !expiry.After(time.Now()) {
		return "invalid (expired at " + expiry.Format(time.RFC3339) + ")"
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	_, err := c.Get(ctx, "/api/v1/me")
	if errors.Is(err, ErrAuthentication) {
		return "invalid (rejected by Access or Worker policy)"
	}
	if err != nil {
		return "unknown (could not verify with Worker: " + err.Error() + ")"
	}
	if hasExpiry {
		return fmt.Sprintf("valid (verified with Worker; expires %s)", expiry.Format(time.RFC3339))
	}
	return "valid (verified with Worker)"
}
