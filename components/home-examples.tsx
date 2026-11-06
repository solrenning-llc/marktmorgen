"use client";

import { useState } from "react";

/*
 * Two small examples on the home page's "What you can sell." (VS1). Each is
 * labeled as an example on screen: the times and the prices are not anyone's
 * real offer. Pressing a button changes only the example in front of it.
 */

const TIMES = ["9:00 AM", "10:30 AM", "1:00 PM", "2:30 PM", "4:00 PM", "5:30 PM"];

export function ExampleTimes() {
  const [picked, setPicked] = useState(2);
  return (
    <div className="hm-tile-panel">
      <p className="hm-example-label">Example times</p>
      <p className="hm-panel-title">Thursday</p>
      <div role="group" aria-label="Example times on Thursday" className="hm-times">
        {TIMES.map((time, i) => (
          <button key={time} type="button" aria-pressed={i === picked} onClick={() => setPicked(i)} className="hm-time">
            {time}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ExampleMembership() {
  const [yearly, setYearly] = useState(false);
  return (
    <div className="hm-tile-panel">
      <p className="hm-example-label">Example price set by a creator</p>
      <div role="group" aria-label="How often the example member pays" className="hm-toggle">
        <button type="button" aria-pressed={!yearly} onClick={() => setYearly(false)}>Monthly</button>
        <button type="button" aria-pressed={yearly} onClick={() => setYearly(true)}>Yearly</button>
      </div>
      <p className="hm-member-price" aria-live="polite">{yearly ? "$190 a year" : "$19 a month"}</p>
    </div>
  );
}
