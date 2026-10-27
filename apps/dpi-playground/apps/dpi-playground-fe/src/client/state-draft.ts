// Draft editing for the device-wide App State JSON (Inspector's State tab).
// A draft always belongs to one device feed at one revision: switching devices
// resets it unconditionally (a context loss, never a silent cross-device
// write), a remote revision change while dirty is a conflict the user must
// resolve, and the text is pre-validated (debounced) with the same checks the
// device runs on save.
import { computed, ref, watch, type Ref } from "vue";
import { changeState, type AppState } from "@sdk/app-state";
import { message } from "./hub";

export type SharedStateFeed = { value: AppState; revision: number } | undefined;

/** The same checks the device runs on save — a root update through the SDK's
 *  changeState: JSON-object shape, the nesting and size limits, reserved
 *  field names. Empty when the text is a saveable state document. */
export function draftProblem(text: string): string {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value !== "object")
      throw Error("App State must be a JSON object.");
    changeState({}, { operation: "update", path: "", value: value as AppState });
    return "";
  } catch (e) {
    return message(e);
  }
}

export function useStateDraft(shared: Ref<SharedStateFeed>, deviceId: Ref<string | undefined>) {
  const draft = ref("");
  const baseline = ref("");
  const revision = ref(0);
  const draftDevice = ref<string>();
  const saving = ref(false);
  /** The draft's validation problem, refreshed (debounced) as the user types. */
  const problem = ref("");
  const dirty = computed(() => draft.value !== baseline.value);
  /** The draft was loaded from another device — possible for one tick while a
   *  device switch settles; never a saveable state. */
  const deviceChanged = computed(() => dirty.value && draftDevice.value !== deviceId.value);
  const conflict = computed(
    () => dirty.value && (deviceChanged.value || shared.value?.revision !== revision.value),
  );

  function reset() {
    draft.value = JSON.stringify(shared.value?.value ?? {}, null, 2);
    baseline.value = draft.value;
    revision.value = shared.value?.revision ?? 0;
    draftDevice.value = deviceId.value;
    problem.value = "";
  }
  /** Adopt a successful save's result: the saved text becomes the new
   *  baseline at the device's new revision. */
  function commit(value: unknown, atRevision: number) {
    draft.value = JSON.stringify(value, null, 2);
    baseline.value = draft.value;
    revision.value = atRevision;
    problem.value = "";
  }
  // A clean draft follows the feed; a dirty one keeps the user's text until a
  // new revision turns it into a conflict.
  watch(shared, () => !dirty.value && reset(), { immediate: true });
  // A device switch is always a context loss: drop the draft, dirty or not.
  watch(deviceId, () => reset());
  // Pre-validate as the user types (debounced) so the depth/size limits
  // surface before the Save click, not after it.
  let timer: ReturnType<typeof setTimeout> | undefined;
  watch(draft, () => {
    clearTimeout(timer);
    timer = setTimeout(() => (problem.value = dirty.value ? draftProblem(draft.value) : ""), 250);
  });
  return { draft, dirty, conflict, deviceChanged, saving, problem, revision, reset, commit };
}
