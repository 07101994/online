/*
 * L.Control.StatusIndicator is used for displaying the current loading status
 */

L.Control.StatusIndicator = L.Control.extend({
	options: {
		position: 'topleft',
	},

	onAdd: function (map) {
		var partName = 'leaflet-control-statusindicator';
		this._container = L.DomUtil.create('div', partName + ' leaflet-bar');

		map.on('statusindicator:start statusindicator:setvalue statusindicator:finish',
			this._updateStatus, this);
		return this._container;
	},

	_updateStatus: function (e) {
		if (e.type === 'statusindicator:start') {
			L.DomUtil.setStyle(this._container, 'display', '');
			this._container.innerText = '0 %';
		}
		else if (e.type === 'statusindicator:setvalue') {
			this._container.innerText = e.statusIndicator + '% ';
		}
		else if (e.type === 'statusindicator:finish') {
			L.DomUtil.setStyle(this._container, 'display', 'none');
		}
	}
});

L.Map.mergeOptions({
	statusIndicatorControl: true
});

L.Map.addInitHook(function () {
	if (this.options.statusIndicatorControl) {
		this.statusIndicatorControl = new L.Control.StatusIndicator();
		this.addControl(this.statusIndicatorControl);
	}
});

L.control.statusIndicator = function (options) {
	return new L.Control.StatusIndicator(options);
};
