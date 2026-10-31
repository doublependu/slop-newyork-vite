// The city is too big to build before the first frame, so its builders are generators. They run until they yield
// Ready, which marks the point where the starting view is complete. WorldBuilder then resumes them a few milliseconds
// per frame while the game is already playable.

class Ready {
  constructor(value) {
    this.value = value;
  }
}

function runUntilReady(job) {
  for (;;) {
    const { value, done } = job.next();
    if (done || value instanceof Ready) return value instanceof Ready ? value.value : value;
  }
}

function runToEnd(job) {
  let step = job.next();
  while (!step.done) step = job.next();
  return step.value;
}

class WorldBuilder {
  constructor(job) {
    this.job = job;
    this.waiting = false;
    this.done = false;
  }

  // A job can yield a promise to wait for async work, such as shader compiles, without holding up any frames.
  step(budgetMs) {
    if (this.done || this.waiting) return;
    const deadline = performance.now() + budgetMs;
    do {
      const { value, done } = this.job.next();
      if (done) {
        this.done = true;
        return;
      }
      if (typeof value?.then === 'function') {
        this.waiting = true;
        value.then(() => { this.waiting = false; });
        return;
      }
    } while (performance.now() < deadline);
  }
}

export { Ready, WorldBuilder, runToEnd, runUntilReady };
