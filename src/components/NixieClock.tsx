/**
 * Nixie numerals drawn as single-stroke wire cathodes on a 100x140 grid.
 * A real nixie tube stacks ten of these in front of a mesh anode; this file
 * keeps the same idea so a digit change rolls rather than swaps.
 */
const GLYPHS = [
  "M50 16 C31 16 24 32 24 70 C24 108 31 124 50 124 C69 124 76 108 76 70 C76 32 69 16 50 16 Z",
  "M36 42 L50 18 L50 124 M32 124 L68 124",
  "M24 40 C24 20 39 12 50 12 C63 12 76 20 76 38 C76 54 66 64 52 76 L26 104 L26 124 L78 124",
  "M26 26 C34 14 48 12 58 14 C72 17 78 28 76 42 C74 56 64 62 50 64 C70 66 80 78 78 94 C76 112 62 126 46 124 C35 123 28 118 24 110",
  "M64 124 L64 16 L24 88 L82 88",
  "M76 16 L32 16 L28 66 C36 58 48 54 58 58 C72 63 79 76 78 92 C77 112 64 126 48 125 C34 124 27 117 24 108",
  "M72 22 C64 14 54 12 46 16 C32 22 24 40 24 74 C24 110 34 126 50 126 C68 126 78 114 78 96 C78 78 68 68 52 68 C36 68 26 76 24 88",
  "M24 16 L78 16 L46 124",
  "M50 66 C36 66 26 58 26 42 C26 24 36 14 50 14 C64 14 74 24 74 42 C74 58 64 66 50 66 Z M50 66 C34 66 24 76 24 94 C24 114 34 126 50 126 C66 126 76 114 76 94 C76 76 66 66 50 66 Z",
  "M26 118 C36 128 50 128 58 122 C70 113 76 96 76 66 C76 32 66 14 50 14 C32 14 22 26 22 44 C22 62 32 74 48 74 C64 74 74 64 76 52",
];

function Tube({ value }: { value: number | null }) {
  const lit = value !== null;
  return (
    <span className={lit ? "nixie-tube" : "nixie-tube is-dark"}>
      <svg className="nixie-svg" viewBox="0 0 100 140" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <g
          className="nixie-roll"
          style={{ transform: `translateY(${lit ? -value * 140 : 0}px)` }}
        >
          {GLYPHS.map((glyph, index) => (
            <path key={index} d={glyph} transform={`translate(0 ${index * 140})`} />
          ))}
        </g>
      </svg>
      <span className="nixie-mesh" />
      <span className="nixie-mica top" />
      <span className="nixie-mica bottom" />
    </span>
  );
}

/** Machined plate with four glass nixie tubes showing 12-hour time and AM/PM. */
export function NixieClock({ now, motion }: { now: number; motion: boolean }) {
  const date = new Date(now);
  const hours24 = date.getHours();
  const meridiem = hours24 >= 12 ? "PM" : "AM";
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const minutes = date.getMinutes();
  const label = `${hours12}:${String(minutes).padStart(2, "0")} ${meridiem}`;

  return (
    <time
      className={motion ? "nixie-clock nixie-live" : "nixie-clock"}
      dateTime={date.toISOString()}
      title={date.toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" })}
      aria-label={label}
    >
      <span className="nixie-screw" aria-hidden="true" />
      <Tube value={hours12 >= 10 ? Math.floor(hours12 / 10) : null} />
      <Tube value={hours12 % 10} />
      <span className="nixie-colon" aria-hidden="true">
        <i />
        <i />
      </span>
      <Tube value={Math.floor(minutes / 10)} />
      <Tube value={minutes % 10} />
      <span className="nixie-meridiem" aria-hidden="true">
        <b className={meridiem === "AM" ? "on" : ""}>AM</b>
        <b className={meridiem === "PM" ? "on" : ""}>PM</b>
      </span>
      <span className="nixie-screw" aria-hidden="true" />
      <span className="nixie-sr">{label}</span>
    </time>
  );
}
