import { useId, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { DIRECTIONS } from "@g2048/contracts";
import type { Direction } from "@g2048/contracts";
import { useServices, useSettings } from "../app/services.js";
import { Tile } from "../components/Tile.js";
import { DEFAULT_KEY_BINDINGS, describeKey, normalizeKey, RESERVED_KEYS } from "../input/keyboard.js";
import type { Settings } from "../settings/store.js";

type Option<T extends string> = { value: T; label: string; hint?: string };

function RadioGroup<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
  children,
}: {
  legend: string;
  name: string;
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  children?: ReactNode;
}) {
  return (
    <fieldset className="field">
      <legend>{legend}</legend>
      <div className="segmented">
        {options.map((o) => (
          <label key={o.value} className="segmented__item">
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
            />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
      {children}
    </fieldset>
  );
}

const DIRECTION_LABEL: Record<Direction, string> = { up: "Up", right: "Right", down: "Down", left: "Left" };

function KeyBindingsEditor({
  settings,
  update,
}: {
  settings: Settings;
  update: (p: Partial<Settings>) => void;
}) {
  const [capturing, setCapturing] = useState<Direction | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const capture = (direction: Direction) => (event: KeyboardEvent<HTMLButtonElement>) => {
    if (capturing !== direction) return;
    if (event.key === "Tab") return; // keep keyboard navigation working
    event.preventDefault();
    if (event.key === "Escape") {
      setCapturing(null);
      setMessage("Key capture cancelled.");
      return;
    }
    if (RESERVED_KEYS.has(event.key) || ["Shift", "Control", "Alt", "Meta"].includes(event.key)) {
      setMessage(`${describeKey(event.key)} is reserved and can't be bound.`);
      return;
    }
    const key = normalizeKey(event.key);
    const current = settings.keyBindings;
    const owner = DIRECTIONS.find((d) => current[d].some((k) => normalizeKey(k) === key));
    const next: Record<Direction, string[]> = {
      up: [...current.up],
      right: [...current.right],
      down: [...current.down],
      left: [...current.left],
    };
    if (owner) next[owner] = next[owner].filter((k) => normalizeKey(k) !== key);
    if (owner && next[owner].length === 0) {
      setMessage(
        `${describeKey(key)} is the only key for ${DIRECTION_LABEL[owner]}; add another key there first.`,
      );
      return;
    }
    next[direction] = [...next[direction].filter((k) => normalizeKey(k) !== key), key].slice(-4);
    update({ keyBindings: next });
    setCapturing(null);
    setMessage(`${describeKey(key)} now moves ${DIRECTION_LABEL[direction].toLowerCase()}.`);
  };

  return (
    <fieldset className="field">
      <legend>Keyboard bindings</legend>
      <p className="hint hint--small">
        Game keys only work while the board has focus. Up to 4 keys per direction.
      </p>
      <table className="bindings">
        <tbody>
          {DIRECTIONS.map((d) => (
            <tr key={d}>
              <th scope="row">{DIRECTION_LABEL[d]}</th>
              <td>
                {settings.keyBindings[d].map((k) => (
                  <kbd key={k}>{describeKey(k)}</kbd>
                ))}
              </td>
              <td>
                <button
                  type="button"
                  className="button button--small"
                  aria-pressed={capturing === d}
                  onClick={() => {
                    setCapturing(capturing === d ? null : d);
                    setMessage(
                      capturing === d ? null : `Press a key for ${DIRECTION_LABEL[d]} (Escape cancels).`,
                    );
                  }}
                  onKeyDown={capture(d)}
                >
                  {capturing === d ? "Press a key…" : `Add key for ${DIRECTION_LABEL[d]}`}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint hint--small" role="status">
        {message}
      </p>
      <button
        type="button"
        className="button button--small"
        onClick={() => update({ keyBindings: DEFAULT_KEY_BINDINGS })}
      >
        Reset keys to arrows + WASD
      </button>
    </fieldset>
  );
}

export function SettingsScreen() {
  const { settings: store } = useServices();
  const settings = useSettings();
  const id = useId();
  const update = (patch: Partial<Settings>) => store.update(patch);

  return (
    <div className="panel form">
      <p className="lede">Preferences are saved in this browser for the guest player.</p>

      <RadioGroup
        legend="Theme"
        name="theme"
        value={settings.theme}
        onChange={(theme) => update({ theme })}
        options={[
          { value: "system", label: "System" },
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
          { value: "high-contrast", label: "High contrast" },
        ]}
      />

      <RadioGroup
        legend="Motion"
        name="motion"
        value={settings.motion}
        onChange={(motion) => update({ motion })}
        options={[
          { value: "system", label: "Follow system" },
          { value: "reduced", label: "Reduced" },
          { value: "full", label: "Full" },
        ]}
      />

      <RadioGroup
        legend="Tile labels"
        name="tileDisplay"
        value={settings.tileDisplay}
        onChange={(tileDisplay) => update({ tileDisplay })}
        options={[
          { value: "auto", label: "Auto" },
          { value: "value", label: "Prefer numbers" },
          { value: "exponent", label: "Powers of two" },
        ]}
      >
        <p className="hint hint--small">
          Auto shows numbers up to 6 digits, then 2<sup>n</sup>. Every tile&apos;s exact value is in its
          tooltip.
        </p>
        <div className="tile-preview" aria-label="Preview">
          {["3", "11", "17", "24", "4096"].map((e) => (
            <div className="tile-preview__cell" key={e}>
              <Tile exponent={e} style={settings.tileDisplay} />
            </div>
          ))}
        </div>
      </RadioGroup>

      <label className="check">
        <input
          type="checkbox"
          checked={settings.soundMuted}
          onChange={(e) => update({ soundMuted: e.target.checked })}
        />
        <span>Mute sounds</span>
      </label>

      <div className="field">
        <label htmlFor={`${id}-bot`}>Bot playback speed</label>
        <div className="range-row">
          <input
            id={`${id}-bot`}
            type="range"
            min={0}
            max={5000}
            step={100}
            value={settings.botSpeedMs}
            onChange={(e) => update({ botSpeedMs: Number.parseInt(e.target.value, 10) })}
            aria-valuetext={`${settings.botSpeedMs} milliseconds per move`}
          />
          <output htmlFor={`${id}-bot`}>
            {settings.botSpeedMs === 0 ? "Instant" : `${settings.botSpeedMs} ms/move`}
          </output>
        </div>
        <p className="hint hint--small">Used by the bot laboratory and bot replays.</p>
      </div>

      <KeyBindingsEditor settings={settings} update={update} />

      <div className="action-row">
        <button type="button" className="button button--ghost" onClick={() => store.reset()}>
          Reset all settings
        </button>
      </div>
    </div>
  );
}
