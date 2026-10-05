import {
  channelReading,
  monitorChannels,
  type CalibrationProfile,
  type CalibratedChannel,
  type SensorChannel,
  type SensorFrame,
  type SensorLabApi,
  type SensorLabState,
  type SensorRecording,
  type SensorRecordingSummary,
} from "../../shared/sensor-lab.js";
import { identityCalibration } from "../../shared/sensor-calibration.js";
import type { MonitorState } from "./monitor-controller.js";

export interface SensorLabViewState {
  lab: SensorLabState;
  selected: CalibratedChannel[];
  available: SensorChannel[];
  preview: SensorFrame[];
  previewStartedAt: number;
  current: SensorRecording | undefined;
  comparison: SensorRecording | undefined;
  history: SensorRecordingSummary[];
  profiles: CalibrationProfile[];
  loading: boolean;
  busy: boolean;
  error: string | undefined;
}

const initialLab = (): SensorLabState => ({
  recording: undefined,
  active: false,
  waiting: false,
  saved: true,
  error: undefined,
  issues: [],
});

/** Renderer view state only; recording and disk persistence belong to the main process. */
export class SensorLabController {
  private state: SensorLabViewState = {
    lab: initialLab(),
    selected: [],
    available: [],
    preview: [],
    previewStartedAt: 0,
    current: undefined,
    comparison: undefined,
    history: [],
    profiles: [],
    loading: true,
    busy: false,
    error: undefined,
  };
  private listeners = new Set<() => void>();
  private stopListening: (() => void) | undefined;
  private initialization: Promise<void> | undefined;
  private revision = 0;
  private lifecycle = 0;
  private historyRequest = 0;
  private sessionId: string | undefined;
  private lastSample: number | undefined;
  private previewSegment = 0;
  private wasLive = false;

  constructor(private api: SensorLabApi) {}
  getSnapshot = (): SensorLabViewState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(patch: Partial<SensorLabViewState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  initialize(): Promise<void> {
    if (this.initialization) return this.initialization;
    const lifecycle = ++this.lifecycle;
    this.update({ loading: true, busy: false });
    this.stopListening = this.api.onState((state) => {
      if (lifecycle !== this.lifecycle) return;
      this.revision++;
      this.accept(state);
    });
    const revision = this.revision;
    this.initialization = Promise.allSettled([
      this.api.getState().then((state) => {
        if (lifecycle === this.lifecycle && this.revision === revision) this.accept(state);
      }),
      this.refreshHistory(),
      this.api.listCalibrations().then((profiles) => {
        if (lifecycle === this.lifecycle) this.update({ profiles });
      }),
    ]).then((results) => {
      if (lifecycle !== this.lifecycle) return;
      const failure = results.find((result) => result.status === "rejected");
      this.update({
        loading: false,
        ...(failure?.status === "rejected" ? { error: errorMessage(failure.reason) } : {}),
      });
    });
    return this.initialization;
  }
  dispose(): void {
    this.lifecycle++;
    this.historyRequest++;
    this.stopListening?.();
    this.stopListening = undefined;
    this.initialization = undefined;
    this.listeners.clear();
  }
  private accept(lab: SensorLabState): void {
    const previous = this.state.lab;
    const show = lab.active || previous.active || !this.state.current;
    this.update({ lab, ...(show ? { current: lab.recording } : {}) });
    const lifecycle = this.lifecycle;
    if (previous.active && !lab.active)
      void this.refreshHistory().catch((error) => {
        if (lifecycle === this.lifecycle) this.update({ error: errorMessage(error) });
      });
  }
  /** Feeding a repeated or stale snapshot never creates a fabricated sample. */
  observeMonitor(monitor: MonitorState): void {
    if (monitor.sessionId !== this.sessionId) {
      this.sessionId = monitor.sessionId;
      this.lastSample = undefined;
      this.wasLive = false;
      this.previewSegment++;
      this.update({ selected: [], available: [], preview: [], previewStartedAt: 0 });
    }
    const snapshot = monitor.snapshot;
    if (!snapshot || monitor.status !== "live" || !monitor.sessionId) {
      if (this.wasLive) this.previewSegment++;
      this.wasLive = false;
      return;
    }
    this.wasLive = true;
    if (snapshot.sampledAt === this.lastSample) return;
    this.lastSample = snapshot.sampledAt;
    const available = monitorChannels(snapshot);
    const started = this.state.previewStartedAt || snapshot.sampledAt;
    const frame: SensorFrame = {
      sampledAt: snapshot.sampledAt,
      elapsedMs: snapshot.sampledAt - started,
      values: this.state.selected.map(({ source }) => channelReading(snapshot, source)),
      status: "ok",
      segment: this.previewSegment,
    };
    const preview = [...this.state.preview, frame]
      .filter((item) => item.sampledAt >= snapshot.sampledAt - 60_000)
      .slice(-240);
    this.update({ available, preview, previewStartedAt: started });
  }
  toggleChannel(source: SensorChannel): void {
    if (this.state.lab.active || this.state.busy) return;
    const existing = this.state.selected.some((item) => item.source.id === source.id);
    if (!existing && this.state.selected.length >= 4) return;
    this.update({
      selected: existing
        ? this.state.selected.filter((item) => item.source.id !== source.id)
        : [...this.state.selected, { source, calibration: identityCalibration(source.unit) }],
      preview: [],
      previewStartedAt: 0,
    });
    this.lastSample = undefined;
  }
  setCalibration(sourceId: string, calibration: CalibratedChannel["calibration"]): void {
    if (this.state.lab.active || this.state.busy) return;
    this.update({
      selected: this.state.selected.map((item) =>
        item.source.id === sourceId ? { ...item, calibration } : item,
      ),
    });
  }
  useLivePreview(): void {
    if (!this.state.lab.active) this.update({ current: undefined });
  }
  clearComparison(): void {
    this.update({ comparison: undefined });
  }
  dismissError(): void {
    this.update({ error: undefined });
  }
  private async command<T>(
    action: () => Promise<T>,
    accept?: (result: T) => void,
  ): Promise<boolean> {
    if (this.state.busy) return false;
    const lifecycle = this.lifecycle;
    this.update({ busy: true, error: undefined });
    try {
      const result = await action();
      if (lifecycle !== this.lifecycle) return false;
      accept?.(result);
      return true;
    } catch (error) {
      if (lifecycle === this.lifecycle) this.update({ error: errorMessage(error) });
      return false;
    } finally {
      if (lifecycle === this.lifecycle) this.update({ busy: false });
    }
  }
  start(sessionId: string, name: string): Promise<boolean> {
    if (this.state.lab.active || !this.state.selected.length) return Promise.resolve(false);
    const previous = this.state.current;
    return this.command(
      () => this.api.start({ sessionId, name, channels: this.state.selected }),
      (lab) => {
        this.accept(lab);
        if (lab.recording) this.update({ current: lab.recording });
        if (previous && previous.id !== lab.recording?.id) this.update({ comparison: previous });
      },
    );
  }
  stop(): Promise<boolean> {
    return this.command(
      () => this.api.stop("manual"),
      (lab) => this.accept(lab),
    );
  }
  retrySave(): Promise<boolean> {
    return this.command(
      async () => {
        const lab = await this.api.retrySave();
        const [profiles, history] = await Promise.all([
          this.api.listCalibrations(),
          this.api.list(),
        ]);
        return { lab, profiles, history };
      },
      ({ lab, profiles, history }) => {
        this.accept(lab);
        this.update({ profiles, history });
      },
    );
  }
  async refreshHistory(): Promise<void> {
    const request = ++this.historyRequest;
    const lifecycle = this.lifecycle;
    const history = await this.api.list();
    if (request === this.historyRequest && lifecycle === this.lifecycle) this.update({ history });
  }
  refresh(): Promise<boolean> {
    return this.command(() => this.refreshHistory());
  }
  readRecording(id: string, comparison = false): Promise<boolean> {
    if (!comparison && this.state.lab.active) return Promise.resolve(false);
    return this.command(
      () => this.api.read(id),
      (recording) => this.update(comparison ? { comparison: recording } : { current: recording }),
    );
  }
  deleteRecording(id: string): Promise<boolean> {
    if (this.state.lab.active && this.state.lab.recording?.id === id) return Promise.resolve(false);
    return this.command(
      async () => {
        await this.api.delete(id);
        return this.api.list();
      },
      (history) => {
        this.update({
          history,
          ...(this.state.current?.id === id ? { current: undefined } : {}),
          ...(this.state.comparison?.id === id ? { comparison: undefined } : {}),
        });
      },
    );
  }
  exportRecording(id: string): Promise<boolean> {
    return this.command(() => this.api.exportCsv(id));
  }
  saveProfile(name: string, channel: CalibratedChannel): Promise<boolean> {
    if (this.state.lab.active) return Promise.resolve(false);
    return this.command(
      () => this.api.saveCalibration({ name, ...channel }),
      (profile) =>
        this.update({
          profiles: [...this.state.profiles.filter((item) => item.id !== profile.id), profile],
        }),
    );
  }
  applyProfile(profile: CalibrationProfile, sourceId: string): void {
    if (profile.source.id !== sourceId) return;
    this.setCalibration(sourceId, { ...profile.calibration });
  }
  deleteProfile(id: string): Promise<boolean> {
    if (this.state.lab.active) return Promise.resolve(false);
    return this.command(
      () => this.api.deleteCalibration(id),
      () => this.update({ profiles: this.state.profiles.filter((profile) => profile.id !== id) }),
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
