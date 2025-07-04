// @ts-ignore
import {api} from "../../scripts/api.js";
// @ts-ignore
import {app} from "../../scripts/app.js";
// @ts-ignore
import {ComfyApp} from "../../scripts/app.js";

import {removeImage} from "./db.js";
import {MaskTool} from "./MaskTool.js";
import {CanvasState} from "./CanvasState.js";
import {CanvasInteractions} from "./CanvasInteractions.js";
import {CanvasLayers} from "./CanvasLayers.js";
import {CanvasLayersPanel} from "./CanvasLayersPanel.js";
import {CanvasRenderer} from "./CanvasRenderer.js";
import {CanvasIO} from "./CanvasIO.js";
import {ImageReferenceManager} from "./ImageReferenceManager.js";
import {BatchPreviewManager} from "./BatchPreviewManager.js";
import {createModuleLogger} from "./utils/LoggerUtils.js";
import { debounce } from "./utils/CommonUtils.js";
import {CanvasMask} from "./CanvasMask.js";
import {CanvasSelection} from "./CanvasSelection.js";
import type { ComfyNode, Layer, Viewport, Point, AddMode } from './types';

const useChainCallback = (original: any, next: any) => {
  if (original === undefined || original === null) {
    return next;
  }
  return function(this: any, ...args: any[]) {
    const originalReturn = original.apply(this, args);
    const nextReturn = next.apply(this, args);
    return nextReturn === undefined ? originalReturn : nextReturn;
  };
};

const log = createModuleLogger('Canvas');

/**
 * Canvas - Fasada dla systemu rysowania
 *
 * Klasa Canvas pełni rolę fasady, oferując uproszczony interfejs wysokiego poziomu
 * dla złożonego systemu rysowania. Zamiast eksponować wszystkie metody modułów,
 * udostępnia tylko kluczowe operacje i umożliwia bezpośredni dostęp do modułów
 * gdy potrzebna jest bardziej szczegółowa kontrola.
 */
export class Canvas {
    batchPreviewManagers: BatchPreviewManager[];
    canvas: HTMLCanvasElement;
    canvasIO: CanvasIO;
    canvasInteractions: CanvasInteractions;
    canvasLayers: CanvasLayers;
    canvasLayersPanel: CanvasLayersPanel;
    canvasMask: CanvasMask;
    canvasRenderer: CanvasRenderer;
    canvasSelection: CanvasSelection;
    canvasState: CanvasState;
    ctx: CanvasRenderingContext2D;
    dataInitialized: boolean;
    height: number;
    imageCache: Map<string, any>;
    imageReferenceManager: ImageReferenceManager;
    interaction: any;
    isMouseOver: boolean;
    lastMousePosition: Point;
    layers: Layer[];
    maskTool: MaskTool;
    node: ComfyNode;
    offscreenCanvas: HTMLCanvasElement;
    offscreenCtx: CanvasRenderingContext2D | null;
    onHistoryChange: ((historyInfo: { canUndo: boolean; canRedo: boolean; }) => void) | undefined;
    onStateChange: (() => void) | undefined;
    pendingBatchContext: any;
    pendingDataCheck: number | null;
    previewVisible: boolean;
    requestSaveState: () => void;
    viewport: Viewport;
    widget: any;
    width: number;

    constructor(node: ComfyNode, widget: any, callbacks: { onStateChange?: () => void, onHistoryChange?: (historyInfo: { canUndo: boolean; canRedo: boolean; }) => void } = {}) {
        this.node = node;
        this.widget = widget;
        this.canvas = document.createElement('canvas');
        const ctx = this.canvas.getContext('2d', {willReadFrequently: true});
        if (!ctx) throw new Error("Could not create canvas context");
        this.ctx = ctx;
        this.width = 512;
        this.height = 512;
        this.layers = [];
        this.onStateChange = callbacks.onStateChange;
        this.onHistoryChange = callbacks.onHistoryChange;
        this.lastMousePosition = {x: 0, y: 0};

        this.viewport = {
            x: -(this.width / 4),
            y: -(this.height / 4),
            zoom: 0.8,
        };

        this.offscreenCanvas = document.createElement('canvas');
        this.offscreenCtx = this.offscreenCanvas.getContext('2d', {
            alpha: false
        });

        this.dataInitialized = false;
        this.pendingDataCheck = null;
        this.imageCache = new Map();

        this.requestSaveState = () => {};
        this.maskTool = new MaskTool(this, {onStateChange: this.onStateChange});
        this.canvasMask = new CanvasMask(this);
        this.canvasState = new CanvasState(this);
        this.canvasSelection = new CanvasSelection(this);
        this.canvasInteractions = new CanvasInteractions(this);
        this.canvasLayers = new CanvasLayers(this);
        this.canvasLayersPanel = new CanvasLayersPanel(this);
        this.canvasRenderer = new CanvasRenderer(this);
        this.canvasIO = new CanvasIO(this);
        this.imageReferenceManager = new ImageReferenceManager(this);
        this.batchPreviewManagers = [];
        this.pendingBatchContext = null;
        this.interaction = this.canvasInteractions.interaction;
        this.previewVisible = false;
        this.isMouseOver = false;

        this._initializeModules();
        this._setupCanvas();

        log.debug('Canvas widget element:', this.node);
        log.info('Canvas initialized', {
            nodeId: this.node.id,
            dimensions: {width: this.width, height: this.height},
            viewport: this.viewport
        });

        this.setPreviewVisibility(false);
    }


    async waitForWidget(name: any, node: any, interval = 100, timeout = 20000) {
        const startTime = Date.now();

        return new Promise((resolve, reject) => {
            const check = () => {
                const widget = node.widgets.find((w: any) => w.name === name);
                if (widget) {
                    resolve(widget);
                } else if (Date.now() - startTime > timeout) {
                    reject(new Error(`Widget "${name}" not found within timeout.`));
                } else {
                    setTimeout(check, interval);
                }
            };

            check();
        });
    }


    /**
     * Kontroluje widoczność podglądu canvas
     * @param {boolean} visible - Czy podgląd ma być widoczny
     */
    async setPreviewVisibility(visible: boolean) {
        this.previewVisible = visible;
        log.info("Canvas preview visibility set to:", visible);

        const imagePreviewWidget = await this.waitForWidget("$$canvas-image-preview", this.node) as any;
        if (imagePreviewWidget) {
            log.debug("Found $$canvas-image-preview widget, controlling visibility");

            if (visible) {
                if (imagePreviewWidget.options) {
                    imagePreviewWidget.options.hidden = false;
                }
                if ('visible' in imagePreviewWidget) {
                    imagePreviewWidget.visible = true;
                }
                if ('hidden' in imagePreviewWidget) {
                    imagePreviewWidget.hidden = false;
                }
                imagePreviewWidget.computeSize = function () {
                    return [0, 250]; // Szerokość 0 (auto), wysokość 250
                };
            } else {
                if (imagePreviewWidget.options) {
                    imagePreviewWidget.options.hidden = true;
                }
                if ('visible' in imagePreviewWidget) {
                    imagePreviewWidget.visible = false;
                }
                if ('hidden' in imagePreviewWidget) {
                    imagePreviewWidget.hidden = true;
                }

                imagePreviewWidget.computeSize = function () {
                    return [0, 0]; // Szerokość 0, wysokość 0
                };
            }
            this.render()
        } else {
            log.warn("$$canvas-image-preview widget not found in Canvas.js");
        }
    }

    /**
     * Inicjalizuje moduły systemu canvas
     * @private
     */
    _initializeModules() {
        log.debug('Initializing Canvas modules...');

        // Stwórz opóźnioną wersję funkcji zapisu stanu
        this.requestSaveState = debounce(() => this.saveState(), 500);

        this._addAutoRefreshToggle();

        log.debug('Canvas modules initialized successfully');
    }

    /**
     * Konfiguruje podstawowe właściwości canvas
     * @private
     */
    _setupCanvas() {
        this.initCanvas();
        this.canvasInteractions.setupEventListeners();
        this.canvasIO.initNodeData();

        this.layers = this.layers.map((layer: Layer) => ({
            ...layer,
            opacity: 1
        }));
    }


    /**
     * Ładuje stan canvas z bazy danych
     */
    async loadInitialState() {
        log.info("Loading initial state for node:", this.node.id);
        const loaded = await this.canvasState.loadStateFromDB();
        if (!loaded) {
            log.info("No saved state found, initializing from node data.");
            await this.canvasIO.initNodeData();
        }
        this.saveState();
        this.render();

        // Dodaj to wywołanie, aby panel renderował się po załadowaniu stanu
        if (this.canvasLayersPanel) {
            this.canvasLayersPanel.onLayersChanged();
        }
    }

    /**
     * Zapisuje obecny stan
     * @param {boolean} replaceLast - Czy zastąpić ostatni stan w historii
     */
    saveState(replaceLast = false) {
        log.debug('Saving canvas state', {replaceLast, layersCount: this.layers.length});
        this.canvasState.saveState(replaceLast);
        this.incrementOperationCount();
        this._notifyStateChange();
    }

    /**
     * Cofnij ostatnią operację
     */
    undo() {
        log.info('Performing undo operation');
        const historyInfo = this.canvasState.getHistoryInfo();
        log.debug('History state before undo:', historyInfo);

        this.canvasState.undo();
        this.incrementOperationCount();
        this._notifyStateChange();

        // Powiadom panel warstw o zmianie stanu warstw
        if (this.canvasLayersPanel) {
            this.canvasLayersPanel.onLayersChanged();
            this.canvasLayersPanel.onSelectionChanged();
        }

        log.debug('Undo completed, layers count:', this.layers.length);
    }


    /**
     * Ponów cofniętą operację
     */
    redo() {
        log.info('Performing redo operation');
        const historyInfo = this.canvasState.getHistoryInfo();
        log.debug('History state before redo:', historyInfo);

        this.canvasState.redo();
        this.incrementOperationCount();
        this._notifyStateChange();

        // Powiadom panel warstw o zmianie stanu warstw
        if (this.canvasLayersPanel) {
            this.canvasLayersPanel.onLayersChanged();
            this.canvasLayersPanel.onSelectionChanged();
        }

        log.debug('Redo completed, layers count:', this.layers.length);
    }

    /**
     * Renderuje canvas
     */
    render() {
        this.canvasRenderer.render();
    }

    /**
     * Dodaje warstwę z obrazem
     * @param {Image} image - Obraz do dodania
     * @param {Object} layerProps - Właściwości warstwy
     * @param {string} addMode - Tryb dodawania
     */
    async addLayer(image: HTMLImageElement, layerProps = {}, addMode: AddMode = 'default') {
        const result = await this.canvasLayers.addLayerWithImage(image, layerProps, addMode);
        
        // Powiadom panel warstw o dodaniu nowej warstwy
        if (this.canvasLayersPanel) {
            this.canvasLayersPanel.onLayersChanged();
        }
        
        return result;
    }

    /**
     * Usuwa wybrane warstwy
     */
    removeLayersByIds(layerIds: string[]) {
        if (!layerIds || layerIds.length === 0) return;

        const initialCount = this.layers.length;
        this.saveState();
        this.layers = this.layers.filter((l: Layer) => !layerIds.includes(l.id));
        
        // If the current selection was part of the removal, clear it
        const newSelection = this.canvasSelection.selectedLayers.filter((l: Layer) => !layerIds.includes(l.id));
        this.canvasSelection.updateSelection(newSelection);
        
        this.render();
        this.saveState();

        if (this.canvasLayersPanel) {
            this.canvasLayersPanel.onLayersChanged();
        }
        log.info(`Removed ${initialCount - this.layers.length} layers by ID.`);
    }

    removeSelectedLayers() {
        return this.canvasSelection.removeSelectedLayers();
    }

    /**
     * Duplikuje zaznaczone warstwy (w pamięci, bez zapisu stanu)
     */
    duplicateSelectedLayers() {
        return this.canvasSelection.duplicateSelectedLayers();
    }

    /**
     * Aktualizuje zaznaczenie warstw i powiadamia wszystkie komponenty.
     * To jest "jedyne źródło prawdy" o zmianie zaznaczenia.
     * @param {Array} newSelection - Nowa lista zaznaczonych warstw
     */
    updateSelection(newSelection: any) {
        return this.canvasSelection.updateSelection(newSelection);
    }

    /**
     * Logika aktualizacji zaznaczenia, wywoływana przez panel warstw.
     */
    updateSelectionLogic(layer: Layer, isCtrlPressed: boolean, isShiftPressed: boolean, index: number) {
        return this.canvasSelection.updateSelectionLogic(layer, isCtrlPressed, isShiftPressed, index);
    }

    /**
     * Zmienia rozmiar obszaru wyjściowego
     * @param {number} width - Nowa szerokość
     * @param {number} height - Nowa wysokość
     * @param {boolean} saveHistory - Czy zapisać w historii
     */
    updateOutputAreaSize(width: number, height: number, saveHistory = true) {
        return this.canvasLayers.updateOutputAreaSize(width, height, saveHistory);
    }

    /**
     * Eksportuje spłaszczony canvas jako blob
     */
    async getFlattenedCanvasAsBlob() {
        return this.canvasLayers.getFlattenedCanvasAsBlob();
    }

    /**
     * Eksportuje spłaszczony canvas z maską jako kanałem alpha
     */
    async getFlattenedCanvasWithMaskAsBlob() {
        return this.canvasLayers.getFlattenedCanvasWithMaskAsBlob();
    }

    /**
     * Importuje najnowszy obraz
     */
    async importLatestImage() {
        return this.canvasIO.importLatestImage();
    }

    _addAutoRefreshToggle() {
        let autoRefreshEnabled = false;
        let lastExecutionStartTime = 0;

        const handleExecutionStart = () => {
            if (autoRefreshEnabled) {
                lastExecutionStartTime = Date.now();
                // Store a snapshot of the context for the upcoming batch
                this.pendingBatchContext = {
                    // For the menu position
                    spawnPosition: {
                        x: this.width / 2,
                        y: this.height
                    },
                    // For the image placement
                    outputArea: {
                        x: 0,
                        y: 0,
                        width: this.width,
                        height: this.height
                    }
                };
                log.debug(`Execution started, pending batch context captured:`, this.pendingBatchContext);
                this.render(); // Trigger render to show the pending outline immediately
            }
        };

        const handleExecutionSuccess = async () => {
            if (autoRefreshEnabled) {
                log.info('Auto-refresh triggered, importing latest images.');

                if (!this.pendingBatchContext) {
                    log.warn("execution_start did not fire, cannot process batch. Awaiting next execution.");
                    return;
                }

                // Use the captured output area for image import
                const newLayers = await this.canvasIO.importLatestImages(
                    lastExecutionStartTime,
                    this.pendingBatchContext.outputArea
                );

                if (newLayers && newLayers.length > 1) {
                    const newManager = new BatchPreviewManager(
                        this,
                        this.pendingBatchContext.spawnPosition,
                        this.pendingBatchContext.outputArea 
                    );
                    this.batchPreviewManagers.push(newManager);
                    newManager.show(newLayers);
                }
                
                // Consume the context
                this.pendingBatchContext = null;
                // Final render to clear the outline if it was the last one
                this.render();
            }
        };

        this.node.addWidget(
            'toggle',
            'Auto-refresh after generation',
            false,
            (value: boolean) => {
                autoRefreshEnabled = value;
                log.debug('Auto-refresh toggled:', value);
            }, {
                serialize: false
            }
        );

        api.addEventListener('execution_start', handleExecutionStart);
        api.addEventListener('execution_success', handleExecutionSuccess);

        (this.node as any).onRemoved = useChainCallback((this.node as any).onRemoved, () => {
            log.info('Node removed, cleaning up auto-refresh listeners.');
            api.removeEventListener('execution_start', handleExecutionStart);
            api.removeEventListener('execution_success', handleExecutionSuccess);
        });
    }


    /**
     * Uruchamia edytor masek
     * @param {Image|HTMLCanvasElement|null} predefinedMask - Opcjonalna maska do nałożenia po otwarciu editora
     * @param {boolean} sendCleanImage - Czy wysłać czysty obraz (bez maski) do editora
     */
    async startMaskEditor(predefinedMask: HTMLImageElement | HTMLCanvasElement | null = null, sendCleanImage: boolean = true) {
        return this.canvasMask.startMaskEditor(predefinedMask as any, sendCleanImage);
    }


    /**
     * Inicjalizuje podstawowe właściwości canvas
     */
    initCanvas() {
        this.canvas.width = this.width;
        this.canvas.height = this.height;
        this.canvas.style.border = '1px solid black';
        this.canvas.style.maxWidth = '100%';
        this.canvas.style.backgroundColor = '#606060';
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvas.tabIndex = 0;
        this.canvas.style.outline = 'none';
    }

    /**
     * Pobiera współrzędne myszy w układzie świata
     * @param {MouseEvent} e - Zdarzenie myszy
     */
    getMouseWorldCoordinates(e: any) {
        const rect = this.canvas.getBoundingClientRect();

        const mouseX_DOM = e.clientX - rect.left;
        const mouseY_DOM = e.clientY - rect.top;

        if (!this.offscreenCanvas) throw new Error("Offscreen canvas not initialized");
        const scaleX = this.offscreenCanvas.width / rect.width;
        const scaleY = this.offscreenCanvas.height / rect.height;

        const mouseX_Buffer = mouseX_DOM * scaleX;
        const mouseY_Buffer = mouseY_DOM * scaleY;

        const worldX = (mouseX_Buffer / this.viewport.zoom) + this.viewport.x;
        const worldY = (mouseY_Buffer / this.viewport.zoom) + this.viewport.y;

        return {x: worldX, y: worldY};
    }

    /**
     * Pobiera współrzędne myszy w układzie widoku
     * @param {MouseEvent} e - Zdarzenie myszy
     */
    getMouseViewCoordinates(e: any) {
        const rect = this.canvas.getBoundingClientRect();
        const mouseX_DOM = e.clientX - rect.left;
        const mouseY_DOM = e.clientY - rect.top;

        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;

        const mouseX_Canvas = mouseX_DOM * scaleX;
        const mouseY_Canvas = mouseY_DOM * scaleY;

        return {x: mouseX_Canvas, y: mouseY_Canvas};
    }

    /**
     * Aktualizuje zaznaczenie po operacji historii
     */
    updateSelectionAfterHistory() {
        return this.canvasSelection.updateSelectionAfterHistory();
    }

    /**
     * Aktualizuje przyciski historii
     */
    updateHistoryButtons() {
        if (this.onHistoryChange) {
            const historyInfo = this.canvasState.getHistoryInfo();
            this.onHistoryChange({
                canUndo: historyInfo.canUndo,
                canRedo: historyInfo.canRedo
            });
        }
    }

    /**
     * Zwiększa licznik operacji (dla garbage collection)
     */
    incrementOperationCount() {
        if (this.imageReferenceManager) {
            this.imageReferenceManager.incrementOperationCount();
        }
    }

    /**
     * Czyści zasoby canvas
     */
    destroy() {
        if (this.imageReferenceManager) {
            this.imageReferenceManager.destroy();
        }
        log.info("Canvas destroyed");
    }

    /**
     * Powiadamia o zmianie stanu
     * @private
     */
    _notifyStateChange() {
        if (this.onStateChange) {
            this.onStateChange();
        }
    }
}
