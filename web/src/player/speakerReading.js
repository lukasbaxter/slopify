// What a reading from a speaker the app drives itself does and does not mean.

// Just paused: a speaker still flipping state reads as playing. That is not a
// resume (11-04, Node: playing again a second after the pause).
export const stillFlipping = (anchor, reading, now) => !anchor.playing && !!reading.playing && now - anchor.at < 2000;

// Playing with the counter stuck at 0: a dead stream, worth one restart. Never
// for a session someone paused: it restarted the song on them.
export const looksStalled = (anchor, reading, reported) => !!anchor.playing && !!reading.playing && reported === 0 && anchor.pos <= 0.5;
