import { describe, expect, test } from "bun:test";
import { createImageStore } from "./image-store.ts";

/* An encoder the test finishes by hand: what the store does while an encode is in flight is
 * exactly the window a page's fetch lands in. */
function manualEncoder() {
  const jobs = [];
  const encode = (px, w, h, channels) => {
    const job = Promise.withResolvers();
    jobs.push({ px, w, h, channels, ...job });
    return job.promise;
  };
  return { encode, jobs };
}

const rgba = (w, h) => new Uint8Array(w * h * 4);

describe("image-store", () => {
  test("one encode per hash; a fetch during the encode waits for it", async () => {
    const { encode, jobs } = manualEncoder();
    const store = createImageStore({ encode });
    expect(store.put("aaaaaaaaaaaaaaaa", "rgba", 2, 2, rgba(2, 2))).toBe(true);
    expect(store.put("aaaaaaaaaaaaaaaa", "rgba", 2, 2, rgba(2, 2))).toBe(true); /* second client */
    expect(jobs).toHaveLength(1);
    const fetched = store.get("aaaaaaaaaaaaaaaa");
    jobs[0].resolve(new Uint8Array([1, 2, 3]));
    expect([...(await fetched)]).toEqual([1, 2, 3]);
    expect(await store.get("bbbbbbbbbbbbbbbb")).toBeNull();
  });

  test("over budget the least recently used go, never the image that just got ready", async () => {
    const { encode, jobs } = manualEncoder();
    const store = createImageStore({ encode, budgetBytes: 100 });
    const ready = async (hash, size) => {
      store.put(hash, "rgba", 1, 1, rgba(1, 1));
      jobs.at(-1).resolve(new Uint8Array(size));
      await store.get(hash);
    };
    await ready("aaaaaaaaaaaaaaaa", 40);
    await ready("bbbbbbbbbbbbbbbb", 40);
    await store.get("aaaaaaaaaaaaaaaa"); /* a page fetched A again: B is now the older one */
    await ready("cccccccccccccccc", 40);
    expect(await store.get("bbbbbbbbbbbbbbbb")).toBeNull();
    expect(await store.get("aaaaaaaaaaaaaaaa")).not.toBeNull();
    /* bigger than the whole budget: still served, the others make room */
    await ready("dddddddddddddddd", 150);
    expect((await store.get("dddddddddddddddd"))?.length).toBe(150);
    expect(store.stats()).toMatchObject({ entries: 1, bytes: 150, pending: 0, evicted: 3 });
  });

  test("a failed encode is forgotten, so the next transmit tries again", async () => {
    const { encode, jobs } = manualEncoder();
    const store = createImageStore({ encode });
    store.put("aaaaaaaaaaaaaaaa", "rgba", 1, 1, rgba(1, 1));
    jobs[0].reject(new Error("boom"));
    expect(await store.get("aaaaaaaaaaaaaaaa")).toBeNull();
    store.put("aaaaaaaaaaaaaaaa", "rgba", 1, 1, rgba(1, 1));
    expect(jobs).toHaveLength(2);
  });

  test("PNG from herdr is served as is; raw pixels without dimensions are refused", async () => {
    const { encode, jobs } = manualEncoder();
    const store = createImageStore({ encode });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    expect(store.put("aaaaaaaaaaaaaaaa", "png", 0, 0, png)).toBe(true);
    expect(await store.get("aaaaaaaaaaaaaaaa")).toBe(png);
    expect(store.put("bbbbbbbbbbbbbbbb", "rgba", 0, 0, rgba(2, 2))).toBe(false);
    expect(store.put("cccccccccccccccc", "rgb", 4, 4, new Uint8Array(10))).toBe(false); /* short */
    expect(jobs).toHaveLength(0);
  });
});
