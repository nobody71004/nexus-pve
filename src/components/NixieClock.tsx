const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/**
 * One glass nixie tube. The ten cathodes are stacked in a column that slides
 * inside the glass, so changing the value rolls the next numeral into place
 * instead of swapping text.
 */
function Tube({ value }: { value: number | null }) {
  const lit = value !== null;
  return (
    <span className={lit ? "nixie-tube" : "nixie-tube is-dark"} aria-hidden="true">
      <span
        className="nixie-cathodes"
        style={{ transform: `translateY(${lit ? -value * 10 : 0}%)` }}
      >
        {DIGITS.map((digit) => (
          <span className="nixie-digit" key={digit}>
            {digit}
          </span>
        ))}
      </span>
      <span className="nixie-mesh" />
      <span className="nixie-glass" />
      <span className="nixie-cap" />
    </span>
  );
}

/** 12-hour nixie clock with an AM/PM selector plate, sized for the title bar. */
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
      <span className="nixie-sr">{label}</span>
    </time>
  );
}
