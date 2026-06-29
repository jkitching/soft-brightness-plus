export class QuickSlider {
    constructor(props = {}) {
        Object.assign(this, props);
        this.menuEnabled = true;
        this.visible = true;
        this._icon = { style: '' };
        this._sliderConnections = [];
        this.slider = {
            _connections: [],
            value: 1.0,
            accessible_name: '',
            connect(signal, fn) {
                const id = this._connections.length + 1;
                this._connections.push({ id, signal, fn });
                return id;
            },
            disconnect(id) {
                this._connections = this._connections.filter(c => c.id !== id);
            },
            block_signal_handler(id) {},
            unblock_signal_handler(id) {},
        };
    }
    destroy() {}
}
