"""Wire-shaped UI data annotations. Bounds/cross-fields are validated by the RPC port.

JSON tuples are represented as lists; their exact lengths and numeric constraints
come from the bundled schema and semantic validators. No resource validator is implied.
"""
from typing import Literal, TypedDict


class PanelBinding(TypedDict):
    contributionId: str
    panelInstance: str
    kind: Literal["panel"]
    uiResourceGeneration: int
    generation: int
    hostEpoch: str
    processEpoch: str


class DatasetSeries(TypedDict):
    id: str
    unit: str
    range: list[float]
    extrema: list[list[float]] | None
    fullPointCount: int
    omittedPoints: int
    omittedRuns: int


class ChartHeader(TypedDict):
    kind: Literal["chart"]
    timeDomain: list[float]
    view: Literal["full", "recent60s"]
    series: list[DatasetSeries]


class TableHeader(TypedDict):
    kind: Literal["table"]


class ListHeader(TypedDict):
    kind: Literal["list"]


class CodeHeader(TypedDict):
    kind: Literal["code"]


DatasetHeader = ChartHeader | TableHeader | ListHeader | CodeHeader


class DatasetRow(TypedDict):
    key: str
    version: str | None
    cells: list[str | float | bool | None]


class ChartChunk(TypedDict):
    kind: Literal["chart"]
    entries: list[list[float]]


class TableChunk(TypedDict):
    kind: Literal["table"]
    entries: list[DatasetRow]


class ListChunk(TypedDict):
    kind: Literal["list"]
    entries: list[DatasetRow]


class CodeChunk(TypedDict):
    kind: Literal["code"]
    entries: list[str]


DatasetChunk = ChartChunk | TableChunk | ListChunk | CodeChunk


class DatasetAddress(TypedDict):
    binding: PanelBinding
    dataset: str


class DataBeginParams(DatasetAddress):
    baseRevision: int
    presentation: int
    header: DatasetHeader
    entryCount: int
    byteLength: int
    sha256: str


class DataTransferParams(DatasetAddress):
    transfer: str


class DataChunkParams(DataTransferParams):
    offset: int
    chunk: DatasetChunk


class DataReadParams(DatasetAddress):
    revision: int
    offset: int
    limit: int


class DataRevision(TypedDict):
    revision: int
    presentation: int
    byteLength: int
    sha256: str


class DatasetMetadata(DataRevision):
    dataset: str


class DataSnapshotValue(TypedDict):
    datasets: list[DatasetMetadata]


class _ReadPage(DataRevision):
    nextOffset: int
    done: bool


class ChartReadValue(_ReadPage):
    header: ChartHeader
    chunk: ChartChunk


class TableReadValue(_ReadPage):
    header: TableHeader
    chunk: TableChunk


class ListReadValue(_ReadPage):
    header: ListHeader
    chunk: ListChunk


class CodeReadValue(_ReadPage):
    header: CodeHeader
    chunk: CodeChunk


DataReadValue = ChartReadValue | TableReadValue | ListReadValue | CodeReadValue


class ResourceDetail(TypedDict):
    kind: Literal["ui-data"]
    reason: Literal["schema", "reference", "offset", "checksum"]


class StaleDetail(TypedDict):
    kind: Literal["ui-data"]
    reason: Literal["revision", "expired", "stale"]


class LimitDetail(TypedDict):
    kind: Literal["ui-data"]
    reason: Literal["quota", "rate", "queue"]


class VersionDetail(TypedDict):
    kind: Literal["ui-data"]
    reason: Literal["version"]


class PermissionDetail(TypedDict):
    kind: Literal["permission"]
    reason: Literal["permission", "user-action-required"]


class ResourceError(TypedDict):
    code: Literal["PLUGIN_E_UI_RESOURCE"]
    message: str
    detail: ResourceDetail


class StaleError(TypedDict):
    code: Literal["PLUGIN_E_STALE_RESOURCE"]
    message: str
    detail: StaleDetail


class LimitError(TypedDict):
    code: Literal["PLUGIN_E_RESOURCE_LIMIT"]
    message: str
    detail: LimitDetail


class VersionError(TypedDict):
    code: Literal["PLUGIN_E_UI_VERSION"]
    message: str
    detail: VersionDetail


class PermissionError(TypedDict):
    code: Literal["PLUGIN_E_PERMISSION_DENIED"]
    message: str
    detail: PermissionDetail


class DataFailure(TypedDict):
    ok: Literal[False]
    error: ResourceError | StaleError | LimitError | VersionError | PermissionError


class DataChunkValue(TypedDict):
    nextOffset: int
    remainingMs: float


class DataBeginValue(TypedDict):
    transfer: str
    nextOffset: Literal[0]
    remainingMs: float


class DataAbortValue(TypedDict):
    aborted: bool


class DataBeginSuccess(TypedDict):
    ok: Literal[True]
    value: DataBeginValue


class DataChunkSuccess(TypedDict):
    ok: Literal[True]
    value: DataChunkValue


class DataCommitSuccess(TypedDict):
    ok: Literal[True]
    value: DataRevision


class DataAbortSuccess(TypedDict):
    ok: Literal[True]
    value: DataAbortValue


class DataReadSuccess(TypedDict):
    ok: Literal[True]
    value: DataReadValue


class DataSnapshotSuccess(TypedDict):
    ok: Literal[True]
    value: DataSnapshotValue


DataBeginResult = DataBeginSuccess | DataFailure
DataChunkResult = DataChunkSuccess | DataFailure
DataCommitResult = DataCommitSuccess | DataFailure
DataAbortResult = DataAbortSuccess | DataFailure
DataReadResult = DataReadSuccess | DataFailure
DataSnapshotResult = DataSnapshotSuccess | DataFailure
