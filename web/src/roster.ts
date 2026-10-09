import type { Spatial } from './audio.js';
import type { Player } from './net.js';

type Row = {
  row: HTMLLabelElement;
  box: HTMLInputElement;
  label: HTMLSpanElement;
};

export type Roster = {
  /**
   * Players this listener has muted. Local only: nothing about it reaches the
   * server or the other players, so two people can mute each other without
   * either one knowing.
   */
  muted: Set<string>;
  update(players: Player[], myId: string, spatial: Spatial[]): void;
};

/**
 * One checkbox per other player, rebuilt only when the set of players
 * changes. Snapshots arrive on every move, so redrawing the list each time
 * would fight with the pointer: existing rows only have their text updated.
 */
export function createRoster(host: HTMLElement, onChange: () => void): Roster {
  const muted = new Set<string>();
  const rows = new Map<string, Row>();

  const hint = document.createElement('span');
  hint.className = 'hint';
  hint.textContent = 'mute';
  const list = document.createElement('div');
  list.className = 'list';
  host.append(hint, list);

  function addRow(player: Player): Row {
    const row = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = muted.has(player.id);
    box.addEventListener('change', () => {
      if (box.checked) {
        muted.add(player.id);
      } else {
        muted.delete(player.id);
      }
      onChange();
    });

    const label = document.createElement('span');
    row.append(box, label);
    list.appendChild(row);
    return { row, box, label };
  }

  function update(players: Player[], myId: string, spatial: Spatial[]): void {
    const present = new Set<string>();

    for (const player of players) {
      if (player.id === myId) continue;
      present.add(player.id);

      let entry = rows.get(player.id);
      if (!entry) {
        entry = addRow(player);
        rows.set(player.id, entry);
      }
      const gain = spatial[player.slot]?.gain ?? 0;
      entry.label.textContent = `${player.name} [${player.slot}] ${gain.toFixed(2)}`;
    }

    for (const [id, entry] of rows) {
      if (!present.has(id)) {
        entry.row.remove();
        rows.delete(id);
        // A mute does not outlive the player it was aimed at: ids are never
        // reused, so whoever takes the freed slot starts audible.
        muted.delete(id);
      }
    }

    host.hidden = rows.size === 0;
  }

  return { muted, update };
}
