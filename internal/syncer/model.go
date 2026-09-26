package syncer

type Session struct {
	Device      string `json:"device"`
	Source      string `json:"source"`
	SourceID    string `json:"source_id"`
	Title       string `json:"title"`
	CWD         string `json:"cwd"`
	Path        string `json:"path"`
	Archived    int    `json:"archived"`
	UpdatedAtMS int64  `json:"updated_at_ms"`
}
type Record struct {
	Line int     `json:"line"`
	Role string  `json:"role"`
	Text *string `json:"text"`
}
type Update struct {
	Session Session  `json:"session"`
	Records []Record `json:"records"`
}
type Document struct {
	Session Session
	Records []Record
}
