package syncer

import (
	"encoding/base64"
	"encoding/json"
	"errors"
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
