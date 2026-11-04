package main

import (
	"context"
	"log"
	"time"
)

func syncLoop(ctx context.Context, interval time.Duration, syncOnce func() error) error {
	for {
		if err := syncOnce(); err != nil {
			log.Printf("Sync failed: %v", err)
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
	}
}
