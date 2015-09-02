/*
 * L.TileLayer is used for standard xyz-numbered tile layers.
 */

// Implement String::startsWith which is non-portable (Firefox only, it seems)
// See http://stackoverflow.com/questions/646628/how-to-check-if-a-string-startswith-another-string#4579228

if (typeof String.prototype.startsWith !== 'function') {
	String.prototype.startsWith = function (str) {
		return this.slice(0, str.length) === str;
	};
}

L.TileLayer = L.GridLayer.extend({

	options: {
		maxZoom: 18,

		subdomains: 'abc',
		errorTileUrl: '',
		zoomOffset: 0,

		maxNativeZoom: null, // Number
		tms: false,
		zoomReverse: false,
		detectRetina: false,
		crossOrigin: false,
		preFetchOtherParts: false
	},

	initialize: function (url, options) {

		this._url = url;

		options = L.setOptions(this, options);

		// detecting retina displays, adjusting tileSize and zoom levels
		if (options.detectRetina && L.Browser.retina && options.maxZoom > 0) {

			options.tileSize = Math.floor(options.tileSize / 2);
			options.zoomOffset++;

			options.minZoom = Math.max(0, options.minZoom);
			options.maxZoom--;
		}

		if (typeof options.subdomains === 'string') {
			options.subdomains = options.subdomains.split('');
		}

		// for https://github.com/Leaflet/Leaflet/issues/137
		if (!L.Browser.android) {
			this.on('tileunload', this._onTileRemove);
		}
		this._documentInfo = '';
		// View or edit mode.
		this._permission = 'view';
		// Position and size of the visible cursor.
		this._visibleCursor = new L.LatLngBounds(new L.LatLng(0, 0), new L.LatLng(0, 0));
		// Cursor overlay is visible or hidden (for blinking).
		this._isCursorOverlayVisible = false;
		// Cursor is visible or hidden (e.g. for graphic selection).
		this._isCursorVisible = true;
		// Rectangle graphic selection
		this._graphicSelection = new L.LatLngBounds(new L.LatLng(0, 0), new L.LatLng(0, 0));
		// Position and size of the selection start (as if there would be a cursor caret there).
		this._textSelectionStart = new L.LatLngBounds(new L.LatLng(0, 0), new L.LatLng(0, 0));
		// Position and size of the selection end.
		this._textSelectionEnd = new L.LatLngBounds(new L.LatLng(0, 0), new L.LatLng(0, 0));

		this._lastValidPart = -1;
		// Cursor marker
		this._cursorMarker = null;
		// Graphic marker
		this._graphicMarker = null;
		// Handle start marker
		this._startMarker = L.marker(new L.LatLng(0, 0), {
			icon: L.icon({
				className: 'leaflet-selection-marker-start',
				asDiv: true
			}),
			draggable: true
		});
		// Handle end marker
		this._endMarker = L.marker(new L.LatLng(0, 0), {
			icon: L.icon({
				className: 'leaflet-selection-marker-end',
				asDiv: true
			}),
			draggable: true
		});
		this._emptyTilesCount = 0;
		this._msgQueue = [];
	},

    onAdd: function (map) {
		this._initContainer();
		this._selections = new L.LayerGroup();
		map.addLayer(this._selections);

		this._levels = {};
		this._tiles = {};
		this._tileCache = {};

		map._fadeAnimated = false;
		this._viewReset();
		map.on('drag resize zoomend', this._updateScrollOffset, this);
		map.on('clearselection', this._clearSelections, this);
		map.on('copy', this._onCopy, this);
		map.on('zoomend', this._onUpdateCursor, this);
		map.on('dragstart', this._onDragStart, this);
		map.on('requestloksession', this._onRequestLOKSession, this);
		map.on('error', this._mapOnError, this);
		this._startMarker.on('drag dragend', this._onSelectionHandleDrag, this);
		this._endMarker.on('drag dragend', this._onSelectionHandleDrag, this);
		this._textArea = map._textArea;
		this._textArea.focus();
		if (this.options.readOnly) {
			map.setPermission('readonly');
		}
		else if (this.options.edit) {
			map.setPermission('edit');
		}
		else {
			map.setPermission('view');
		}
		map.fire('statusindicator', {statusType: 'loleafletloaded'});
	},

	getEvents: function () {
		var events = {
			viewreset: this._viewReset,
			movestart: this._moveStart,
			moveend: this._move
		};

		if (!this.options.updateWhenIdle) {
			// update tiles on move, but not more often than once per given interval
			events.move = L.Util.throttle(this._move, this.options.updateInterval, this);
		}

		if (this._zoomAnimated) {
			events.zoomanim = this._animateZoom;
		}

		return events;
	},

	setUrl: function (url, noRedraw) {
		this._url = url;

		if (!noRedraw) {
			this.redraw();
		}
		return this;
	},

	createTile: function (coords, done) {
		var tile = document.createElement('img');

		tile.onload = L.bind(this._tileOnLoad, this, done, tile);
		tile.onerror = L.bind(this._tileOnError, this, done, tile);

		if (this.options.crossOrigin) {
			tile.crossOrigin = '';
		}

		/*
		 Alt tag is set to empty string to keep screen readers from reading URL and for compliance reasons
		 http://www.w3.org/TR/WCAG20-TECHS/H67
		*/
		tile.alt = '';
		this._emptyTilesCount += 1;
		return tile;
	},

	_onMessage: function (textMsg, imgBytes, index) {
		if (textMsg.startsWith('cursorvisible:')) {
			this._onCursorVisibleMsg(textMsg);
		}
		else if (textMsg.startsWith('invalidatecursor:')) {
			this._onInvalidateCursorMsg(textMsg);
		}
		else if (textMsg.startsWith('textselectionstart:')) {
			this._onTextSelectionStartMsg(textMsg);
		}
		else if (textMsg.startsWith('textselectionend:')) {
			this._onTextSelectionEndMsg(textMsg);
		}
		else if (textMsg.startsWith('graphicselection:')) {
			this._onGraphicSelectionMsg(textMsg);
		}
		else if (textMsg.startsWith('invalidatetiles:') && !textMsg.match('EMPTY')) {
			this._onInvalidateTilesMsg(textMsg);
		}
		else if (textMsg.startsWith('statechanged:')) {
			this._onStateChangedMsg(textMsg);
		}
		else if (textMsg.startsWith('status:')) {
			this._onStatusMsg(textMsg);
		}
		else if (textMsg.startsWith('statusindicator')) {
			this._onStatusIndicatorMsg(textMsg);
		}
		else if (textMsg.startsWith('tile:')) {
			this._onTileMsg(textMsg, imgBytes, index);
		}
		else if (textMsg.startsWith('textselection:')) {
			this._onTextSelectionMsg(textMsg);
		}
		else if (textMsg.startsWith('textselectioncontent:')) {
			this._onTextSelectionContentMsg(textMsg);
		}
		else if (textMsg.startsWith('setpart:')) {
			this._onSetPartMsg(textMsg);
		}
		else if (textMsg.startsWith('searchnotfound:')) {
			this._onSearchNotFoundMsg(textMsg);
		}
		else if (textMsg.startsWith('styles:')) {
			this._onStylesMsg(textMsg);
		}
		else if (textMsg.startsWith('error:')) {
			this._onErrorMsg(textMsg);
		}
	},

	_onCursorVisibleMsg: function(textMsg) {
		var command = textMsg.match('cursorvisible: true');
		this._isCursorVisible = command ? true : false;
		this._isCursorOverlayVisible = true;
		this._onUpdateCursor();
	},

	_onErrorMsg: function (textMsg) {
		var command = L.Socket.parseServerCmd(textMsg);
		this._map.fire('error', {cmd: command.errorCmd, kind: command.errorKind});
	},

	_onGraphicSelectionMsg: function (textMsg) {
		if (textMsg.match('EMPTY')) {
			this._graphicSelection = new L.LatLngBounds(new L.LatLng(0, 0), new L.LatLng(0, 0));
		}
		else {
			var strTwips = textMsg.match(/\d+/g);
			var topLeftTwips = new L.Point(parseInt(strTwips[0]), parseInt(strTwips[1]));
			var offset = new L.Point(parseInt(strTwips[2]), parseInt(strTwips[3]));
			var bottomRightTwips = topLeftTwips.add(offset);
			this._graphicSelection = new L.LatLngBounds(
							this._twipsToLatLng(topLeftTwips, this._map.getZoom()),
							this._twipsToLatLng(bottomRightTwips, this._map.getZoom()));
		}

		this._onUpdateGraphicSelection();
	},

	_onInvalidateCursorMsg: function (textMsg) {
		var strTwips = textMsg.match(/\d+/g);
		var topLeftTwips = new L.Point(parseInt(strTwips[0]), parseInt(strTwips[1]));
		var offset = new L.Point(parseInt(strTwips[2]), parseInt(strTwips[3]));
		var bottomRightTwips = topLeftTwips.add(offset);
		this._visibleCursor = new L.LatLngBounds(
						this._twipsToLatLng(topLeftTwips, this._map.getZoom()),
						this._twipsToLatLng(bottomRightTwips, this._map.getZoom()));
		this._isCursorOverlayVisible = true;
		this._onUpdateCursor();
	},

	_onInvalidateTilesMsg: function (textMsg) {
		var command = L.Socket.parseServerCmd(textMsg);
		if (command.x === undefined || command.y === undefined || command.part === undefined) {
			var strTwips = textMsg.match(/\d+/g);
			command.x = parseInt(strTwips[0]);
			command.y = parseInt(strTwips[1]);
			command.width = parseInt(strTwips[2]);
			command.height = parseInt(strTwips[3]);
			command.part = this._currentPart;
		}
		if (this._docType === 'text') {
			command.part = 0;
		}
		var topLeftTwips = new L.Point(command.x, command.y);
		var offset = new L.Point(command.width, command.height);
		var bottomRightTwips = topLeftTwips.add(offset);
		var invalidBounds = new L.Bounds(topLeftTwips, bottomRightTwips);
		var visibleTopLeft = this._latLngToTwips(this._map.getBounds().getNorthWest());
		var visibleBottomRight = this._latLngToTwips(this._map.getBounds().getSouthEast());
		var visibleArea = new L.Bounds(visibleTopLeft, visibleBottomRight);
		var toRequest = [];

		for (var key in this._tiles) {
			var coords = this._tiles[key].coords;
			var tileTopLeft = this._coordsToTwips(coords);
			var tileBottomRight = new L.Point(this._tileWidthTwips, this._tileHeightTwips);
			var bounds = new L.Bounds(tileTopLeft, tileTopLeft.add(tileBottomRight));
			if (invalidBounds.intersects(bounds) && coords.part === command.part) {
				if (this._tiles[key]._invalidCount) {
					this._tiles[key]._invalidCount += 1;
				}
				else {
					this._tiles[key]._invalidCount = 1;
				}
				if (visibleArea.intersects(bounds)) {
					var msg = 'tile ' +
							'part=' + coords.part + ' ' +
							'width=' + this._tileSize + ' ' +
							'height=' + this._tileSize + ' ' +
							'tileposx=' + tileTopLeft.x + ' '    +
							'tileposy=' + tileTopLeft.y + ' ' +
							'tilewidth=' + this._tileWidthTwips + ' ' +
							'tileheight=' + this._tileHeightTwips;
					toRequest.push({msg: msg, key: key, coords: coords});
				}
				else {
					// tile outside of the visible area, just remove it
					this._preFetchBorder = null;
					this._removeTile(key);
				}
			}
		}

		// Sort tiles so that we request those closer to the cursor first
		var cursorPos = this._map.project(this._visibleCursor.getNorthWest());
		cursorPos = cursorPos.divideBy(this._tileSize);
		toRequest.sort(function(x, y) {return x.coords.distanceTo(cursorPos) - y.coords.distanceTo(cursorPos);});
		for (var i = 0; i < toRequest.length; i++) {
			L.Socket.sendMessage(toRequest[i].msg, toRequest[i].key);
		}

		for (key in this._tileCache) {
			// compute the rectangle that each tile covers in the document based
			// on the zoom level
			coords = this._keyToTileCoords(key);
			if (coords.part !== command.part) {
				continue;
			}
			var scale = this._map.getZoomScale(coords.z);
			topLeftTwips = new L.Point(
					this.options.tileWidthTwips / scale * coords.x,
					this.options.tileHeightTwips / scale * coords.y);
			bottomRightTwips = topLeftTwips.add(new L.Point(
					this.options.tileWidthTwips / scale,
					this.options.tileHeightTwips / scale));
			bounds = new L.Bounds(topLeftTwips, bottomRightTwips);
			if (invalidBounds.intersects(bounds)) {
				delete this._tileCache[key];
			}
		}
		if (command.part === this._currentPart &&
			command.part !== this._lastValidPart) {
			this._lastValidPart = command.part;
			this._map.fire('updatepart', {part: command.part, docType: this._docType});
		}

	},

	_onSearchNotFoundMsg: function (textMsg) {
		var originalPhrase = textMsg.substring(16);
		this._map.fire('search', {originalPhrase: originalPhrase, count: 0});
	},

	_onSetPartMsg: function (textMsg) {
		var part = parseInt(textMsg.match(/\d+/g)[0]);
		if (part !== this._currentPart && this._docType !== 'text') {
			this._currentPart = part;
			this._update();
			this._clearSelections();
			this._map.fire('setpart', {currentPart: this._currentPart});
		}
		else if (this._docType === 'text') {
			this._currentPage = part;
			this._map.fire('pagenumberchanged', {
				currentPage: part,
				pages: this._pages,
				docType: this._docType
			});
		}
	},

	_onStateChangedMsg: function (textMsg) {
		var unoMsg = textMsg.substr(14);
		var unoCmd = unoMsg.match('.uno:(.*)=')[1];
		var state = unoMsg.match('.*=(.*)')[1];
		if (unoCmd && state) {
			this._map.fire('commandstatechanged', {unoCmd : unoCmd, state : state});
		}
	},

	_onStatusMsg: function (textMsg) {
		var command = L.Socket.parseServerCmd(textMsg);
		if (command.width && command.height && this._documentInfo !== textMsg) {
			this._docWidthTwips = command.width;
			this._docHeightTwips = command.height;
			this._docType = command.type;
			this._updateMaxBounds(true);
			this._documentInfo = textMsg;
			this._parts = command.parts;
			this._currentPart = command.currentPart;
			if (this._docType === 'text') {
				this._currentPart = 0;
				this._parts = 1;
				this._currentPage = command.currentPart;
				this._pages = command.parts;
				this._map.fire('pagenumberchanged', {
					currentPage: this._currentPage,
					pages: this._pages,
					docType: this._docType
				});
			}
			else {
				L.Socket.sendMessage('setclientpart part=' + this._currentPart);
				var partNames = textMsg.match(/[^\r\n]+/g);
				// only get the last matches
				partNames = partNames.slice(partNames.length - this._parts);
				this._map.fire('updateparts', {
					currentPart: this._currentPart,
					parts: this._parts,
					docType: this._docType,
					partNames: partNames
				});
			}
			this._update();
			if (this._preFetchPart !== this._currentPart) {
				this._preFetchPart = this._currentPart;
				this._preFetchBorder = null;
			}
		}
	},

	_onStatusIndicatorMsg: function (textMsg) {
		if (textMsg.startsWith('statusindicatorstart:')) {
			this._map.fire('statusindicator', {statusType : 'start'});
		}
		else if (textMsg.startsWith('statusindicatorsetvalue:')) {
			var value = textMsg.match(/\d+/g)[0];
			this._map.fire('statusindicator', {statusType : 'setvalue', value : value});
		}
		else if (textMsg.startsWith('statusindicatorfinish:')) {
			this._map.fire('statusindicator', {statusType : 'finish'});
		}
	},

	_onStylesMsg: function (textMsg) {
		this._docStyles = JSON.parse(textMsg.substring(8));
		this._map.fire('updatestyles', {styles: this._docStyles});
	},

	_onTextSelectionMsg: function (textMsg) {
		var strTwips = textMsg.match(/\d+/g);
		this._clearSelections();
		if (strTwips != null) {
			var rectangles = [];
			var selectionCenter = new L.Point(0, 0);
			for (var i = 0; i < strTwips.length; i += 4) {
				var topLeftTwips = new L.Point(parseInt(strTwips[i]), parseInt(strTwips[i + 1]));
				var offset = new L.Point(parseInt(strTwips[i + 2]), parseInt(strTwips[i + 3]));
				var topRightTwips = topLeftTwips.add(new L.Point(offset.x, 0));
				var bottomLeftTwips = topLeftTwips.add(new L.Point(0, offset.y));
				var bottomRightTwips = topLeftTwips.add(offset);
				rectangles.push([bottomLeftTwips, bottomRightTwips, topLeftTwips, topRightTwips]);
				selectionCenter = selectionCenter.add(topLeftTwips);
				selectionCenter = selectionCenter.add(offset.divideBy(2));
			}
			// average of all rectangles' centers
			selectionCenter = selectionCenter.divideBy(strTwips.length / 4);
			selectionCenter = this._twipsToLatLng(selectionCenter);
			if (!this._map.getBounds().contains(selectionCenter)) {
				var center = this._map.project(selectionCenter);
				center = center.subtract(this._map.getSize().divideBy(2));
				center.x = Math.round(center.x < 0 ? 0 : center.x);
				center.y = Math.round(center.y < 0 ? 0 : center.y);
				this._map.fire('scrollto', {x: center.x, y: center.y});
			}

			var polygons = L.PolyUtil.rectanglesToPolygons(rectangles, this);
			for (i = 0; i < polygons.length; i++) {
				var selection = new L.Polygon(polygons[i], {
					pointerEvents: 'none',
					fillColor: '#43ACE8',
					fillOpacity: 0.25,
					weight: 2,
					opacity: 0.25});
				this._selections.addLayer(selection);
			}
			if (this._selectionContentRequest) {
				clearTimeout(this._selectionContentRequest);
			}
			this._selectionContentRequest = setTimeout(L.bind(function () {
				L.Socket.sendMessage('gettextselection mimetype=text/plain;charset=utf-8');}, this), 100);
		}
		this._onUpdateTextSelection();
	},

	_onTextSelectionContentMsg: function (textMsg) {
		this._selectionTextContent = textMsg.substr(22);
	},

	_onTextSelectionEndMsg: function (textMsg) {
		var strTwips = textMsg.match(/\d+/g);
		if (strTwips != null) {
			var topLeftTwips = new L.Point(parseInt(strTwips[0]), parseInt(strTwips[1]));
			var offset = new L.Point(parseInt(strTwips[2]), parseInt(strTwips[3]));
			var bottomRightTwips = topLeftTwips.add(offset);
			this._textSelectionEnd = new L.LatLngBounds(
						this._twipsToLatLng(topLeftTwips, this._map.getZoom()),
						this._twipsToLatLng(bottomRightTwips, this._map.getZoom()));
		}
		else {
			this._textSelectionEnd = new L.LatLngBounds(new L.LatLng(0, 0), new L.LatLng(0, 0));
		}
	},

	_onTextSelectionStartMsg: function (textMsg) {
		var strTwips = textMsg.match(/\d+/g);
		if (strTwips != null) {
			var topLeftTwips = new L.Point(parseInt(strTwips[0]), parseInt(strTwips[1]));
			var offset = new L.Point(parseInt(strTwips[2]), parseInt(strTwips[3]));
			var bottomRightTwips = topLeftTwips.add(offset);
			this._textSelectionStart = new L.LatLngBounds(
						this._twipsToLatLng(topLeftTwips, this._map.getZoom()),
						this._twipsToLatLng(bottomRightTwips, this._map.getZoom()));
		}
		else {
			this._textSelectionStart = new L.LatLngBounds(new L.LatLng(0, 0), new L.LatLng(0, 0));
		}

	},

	_onTileMsg: function (textMsg, imgBytes, index) {
		var command = L.Socket.parseServerCmd(textMsg);
		var coords = this._twipsToCoords(command);
		coords.z = command.zoom;
		coords.part = command.part;
		var data = imgBytes.subarray(index + 1);

		// read the tile data
		var strBytes = '';
		for (var i = 0; i < data.length; i++) {
			strBytes += String.fromCharCode(data[i]);
		}

		var key = this._tileCoordsToKey(coords);
		var tile = this._tiles[key];
		var img = 'data:image/png;base64,' + window.btoa(strBytes);
		if (command.id !== undefined) {
			this._map.fire('tilepreview', {
				tile: img,
				id: command.id,
				width: command.width,
				height: command.height,
				part: command.part,
				docType: this._docType
			});
		}
		else if (tile) {
			if (this._tiles[key]._invalidCount > 0) {
				this._tiles[key]._invalidCount -= 1;
			}
			if (!tile.loaded) {
				this._emptyTilesCount -= 1;
				if (this._emptyTilesCount === 0) {
					this._map.fire('statusindicator', {statusType: 'alltilesloaded'});
				}
			}
			tile.el.src = img;
		}
		else if (command.preFetch === 'true') {
			this._tileCache[key] = img;
		}
		L.Log.log(textMsg, L.INCOMING, key);

	},

	_tileOnLoad: function (done, tile) {
		done(null, tile);
	},

	_tileOnError: function (done, tile, e) {
		var errorUrl = this.options.errorTileUrl;
		if (errorUrl) {
			tile.src = errorUrl;
		}
		done(e, tile);
	},

   _mapOnError: function (e) {
		if (e.msg) {
			this._map.setPermission('view');
		}
	},

	_onTileRemove: function (e) {
		e.tile.onload = null;
	},

	_clearSelections: function () {
		this._selections.clearLayers();
	},

	_postMouseEvent: function(type, x, y, count) {
		L.Socket.sendMessage('mouse type=' + type +
				' x=' + x + ' y=' + y + ' count=' + count);
	},

	_postKeyboardEvent: function(type, charcode, keycode) {
		L.Socket.sendMessage('key type=' + type +
				' char=' + charcode + ' key=' + keycode);
	},

	_postSelectGraphicEvent: function(type, x, y) {
		L.Socket.sendMessage('selectgraphic type=' + type +
				' x=' + x + ' y=' + y);
	},

	_postSelectTextEvent: function(type, x, y) {
		L.Socket.sendMessage('selecttext type=' + type +
				' x=' + x + ' y=' + y);
	},

	// Is rRectangle empty?
	_isEmptyRectangle: function (aBounds) {
		return aBounds.getSouthWest().equals(new L.LatLng(0, 0)) && aBounds.getNorthEast().equals(new L.LatLng(0, 0));
	},

	// Update cursor layer (blinking cursor).
	_onUpdateCursor: function (e) {
		var pixBounds = L.bounds(this._map.latLngToLayerPoint(this._visibleCursor.getSouthWest()),
						 this._map.latLngToLayerPoint(this._visibleCursor.getNorthEast()));
		var cursorPos = this._visibleCursor.getNorthWest();

		if (!e && !this._map.getBounds().contains(cursorPos) && this._isCursorVisible) {
			var center = this._map.project(cursorPos);
			center = center.subtract(this._map.getSize().divideBy(2));
			center.x = Math.round(center.x < 0 ? 0 : center.x);
			center.y = Math.round(center.y < 0 ? 0 : center.y);
			this._map.fire('scrollto', {x: center.x, y: center.y});
		}

		if (this._permission === 'edit' && this._isCursorVisible && this._isCursorOverlayVisible
				&& !this._isEmptyRectangle(this._visibleCursor)) {
			if (this._cursorMarker) {
				this._map.removeLayer(this._cursorMarker);
			}

			this._cursorMarker = L.cursor(cursorPos);
			this._map.addLayer(this._cursorMarker);
			this._cursorMarker.setSize(pixBounds.getSize().multiplyBy(
						this._map.getZoomScale(this._map.getZoom())));
		}
		else if (this._cursorMarker) {
			this._map.removeLayer(this._cursorMarker);
			this._isCursorOverlayVisible = false;
		}
	},

	// Update dragged graphics selection resize.
	_onGraphicEdit: function (e) {
		if (!e.handle) { return; }

		var aPos = this._latLngToTwips(e.handle.getLatLng());
		if (e.type === 'editstart') {
			this._graphicMarker.isDragged = true;
			this._postSelectGraphicEvent('start', aPos.x, aPos.y);
		}
		else if (e.type === 'editend') {
			this._postSelectGraphicEvent('end', aPos.x, aPos.y);
			this._graphicMarker.isDragged = false;
		}
	},

	// Update dragged text selection.
	_onSelectionHandleDrag: function (e) {
		var aPos = this._latLngToTwips(e.target.getLatLng());

		if (e.type === 'drag') {
			e.target.isDragged = true;
		}
		if (e.type === 'dragend') {
			e.target.isDragged = false;
			this._textArea.focus();
		}

		if (this._startMarker === e.target) {
			this._postSelectTextEvent('start', aPos.x, aPos.y);
		}
		if (this._endMarker === e.target) {
			this._postSelectTextEvent('end', aPos.x, aPos.y);
		}
	},

	// Update group layer selection handler.
	_onUpdateGraphicSelection: function () {
		if (!this._isEmptyRectangle(this._graphicSelection)) {
			if (this._graphicMarker) {
				this._graphicMarker.off('editstart editend', this._onGraphicEdit, this);
				this._map.removeLayer(this._graphicMarker);
			}
			this._graphicMarker = L.rectangle(this._graphicSelection, {fill: false});
			this._graphicMarker.editing.enable();
			this._graphicMarker.on('editstart editend', this._onGraphicEdit, this);
			this._map.addLayer(this._graphicMarker);
		}
		else if (this._graphicMarker) {
			this._graphicMarker.off('editstart editend', this._onGraphicEdit, this);
			this._map.removeLayer(this._graphicMarker);
			this._graphicMarker.isDragged = false;
		}
	},

	// Update text selection handlers.
	_onUpdateTextSelection: function () {
		if (this._selections.getLayers().length !== 0) {
			if (!this._isEmptyRectangle(this._textSelectionStart) && !this._startMarker.isDragged) {
				this._startMarker.setLatLng(this._textSelectionStart.getSouthWest());
				this._map.addLayer(this._startMarker);
			}

			if (!this._isEmptyRectangle(this._textSelectionEnd) && !this._endMarker.isDragged) {
				this._endMarker.setLatLng(this._textSelectionEnd.getSouthEast());
				this._map.addLayer(this._endMarker);
			}
		}
		else {
			this._textSelectionStart = new L.LatLngBounds(new L.LatLng(0, 0), new L.LatLng(0, 0));
			this._textSelectionEnd = new L.LatLngBounds(new L.LatLng(0, 0), new L.LatLng(0, 0));
			this._map.removeLayer(this._startMarker);
			this._map.removeLayer(this._endMarker);
			this._endMarker.isDragged = false;
			this._startMarker.isDragged = false;
		}
	},

	_onCopy: function (e) {
		e = e.originalEvent;
		e.preventDefault();
		if (!this._selectionTextContent) {
			this._map.fire('error', {msg: 'Oops, no content available yet'});
		}
		else {
			e.clipboardData.setData('text/plain', this._selectionTextContent);
		}
	},

	_onDragStart: function () {
		this._map.on('moveend', this._updateScrollOffset, this);
	},

	_onRequestLOKSession: function () {
		L.Socket.sendMessage('requestloksession');
	}
});

L.tileLayer = function (url, options) {
	return new L.TileLayer(url, options);
};
