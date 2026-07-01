import { describe, expect, it } from "vitest";

import { parseRoomSocketMessage } from "./page";

describe("room socket message parsing", () => {
  it("rejects room snapshots without public presence booleans", () => {
    const snapshot = {
      id: "room-test",
      presence: {
        players: {
          A: true,
          B: true,
        },
      },
    };

    expect(
      parseRoomSocketMessage(JSON.stringify({
        type: "ROOM_SNAPSHOT",
        room: snapshot,
      })),
    ).toMatchObject({
      type: "ROOM_SNAPSHOT",
      room: snapshot,
    });

    expect(
      parseRoomSocketMessage(JSON.stringify({
        type: "ROOM_SNAPSHOT",
        room: {
          id: "room-test",
        },
      })),
    ).toBeNull();

    expect(
      parseRoomSocketMessage(JSON.stringify({
        type: "ROOM_SNAPSHOT",
        room: {
          id: "room-test",
          presence: {
            players: {
              A: true,
            },
          },
        },
      })),
    ).toBeNull();
  });
});
