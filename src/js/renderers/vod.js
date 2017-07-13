'use strict';

import window from 'global/window';
import document from 'global/document';
import mejs from '../core/mejs';
import {renderer} from '../core/renderer';
import {createEvent} from '../utils/general';
import {SUPPORTS_NATIVE_HLS, IS_ANDROID} from '../utils/constants';

class VODPlayer {
	
	constructor (media) {
		let s = this;
		s.media = media;
		
		s.mediaSource = null;
		s.socket = null;
		s.sourceBuffer = null;
		s.queue = [];
		s.onsbue = s.onSBUpdateEnd.bind(s);
		s.onsbe  = s.onSBUpdateError.bind(s);
	}
	
	reset () {
		let s = this;
		s.media.pause();
		s.pause = false;
		s.appending = false;
		s.eos = false;
		s._eos = false;
		if (s.socket) {
			s.socket.close();
			s.socket = null;
		}
		
		if (s.queue.length) {
			s.queue.splice(0, s.queue.length);
		}
		
		if (s.mediaSource && s.sourceBuffer) {
			//s.mediaSource.removeSourceBuffer(s.sourceBuffer);
			s.sourceBuffer.removeEventListener('updateend', this.onsbue);
			s.sourceBuffer.removeEventListener('error', this.onsbe);

			s.mediaSource.removeEventListener('sourceopen', s.onmso);
			s.mediaSource.removeEventListener('sourceclose', s.onmsc);

			delete s.mediaSource;
			s.mediaSource = null;
			s.sourceBuffer = null;
		}
		
	}
	
	start () {
		let s = this;
		let socket = s.socket = io.connect();
		socket.on('connect', function(){
			let ms = s.mediaSource = new MediaSource();

			//Media Source listeners
			s.onmso = s.onMediaSourceOpen.bind(s);
// 			s.onmse = s.onMediaSourceEnded.bind(s);
			s.onmsc = s.onMediaSourceClose.bind(s);
			ms.addEventListener('sourceopen', s.onmso);
// 			ms.addEventListener('sourceended', s.onmse);
			ms.addEventListener('sourceclose', s.onmsc);

			// link video and media Source
			s.media.src = URL.createObjectURL(ms);
			s.media.play();
		});
		
	}
	
	retry () {
		let s = this;
		s.offset = s._offset;
		s.reset();
		s.start();
	}

	setSrc (v) {
		let s = this;
		s.reset();
		s.src = v;
		s.offset = 0;
		s._offset = 0;
		s.speed = 1;
		s.duration = 0;
		s.start();
		
	}

	setCurrentTime (v) {
		this.offset = v;
		this.reset();
		this.start();
	}

	setPlaybackRate (v) {
		let s = this;
		if (v != s.speed) {
			s.offset = s.getCurrentTime();
			s.speed = v;
			s.reset();
			s.start();
		}
		
	}
	
	getSrc () {
		return this.src;
	}

	getCurrentTime () {
		let s = this;
		s._offset = s.offset + s.media.currentTime * s.speed;
		return s._offset;
	}
	
	getPlaybackRate (){
		return this.speed;
	}
	
	getDuration () {
		return this.duration;
	}
	
	getBuffered () {
		let s = this;
		let buffered = s.media.buffered;
			
		return {
			start: () => {
				return s.offset + buffered.start(0);
			},
			end: () => {
				return s.offset + buffered.end(0) * s.speed;
			},
			length: buffered.length
		}
	}
	
	onMediaSourceOpen () {
		let mimeCodec = 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"';
		let s = this;
		s.sourceBuffer = s.mediaSource.addSourceBuffer(mimeCodec);
		s.queue = [];
		s.sourceBuffer.addEventListener('updateend', this.onsbue);
		s.sourceBuffer.addEventListener('error', this.onsbe);
		
		const url = require('url');
		s.socket.emit('start', {file:  url.parse(s.src).pathname, offset: s.offset, speed: Math.log2(s.speed)});
		
		s.socket.on('data', function(data){
			s.socket.emit('ack', data.seq);
			s.queue.push(data.buffer);
			if (!s.appending) {
				s.doAppend();
			}
		});
		
		s.socket.on('mediainfo', function(mediainfo){
			s.duration = parseInt(mediainfo['format']['duration']);
		});

		s.socket.on('verbose', function(msg){
			console.log(msg);
		});

		s.socket.on('eos', function(){
			s.eos = true;
		});

		s.socket.on('error', function(){
			s.retry();
		});

		s.socket.on('disconnect', function(reason){
			if (reason != 'io client disconnect') {
				s.retry();
			}
		});
	}
	
	onMediaSourceClose () {
		
	}
	
	doEos () {
		let s = this;
		if (s.eos && !s._eos) {
			if (s.mediaSource.readyState === 'open' && !s.sourceBuffer.updating) {
				try {
					s.mediaSource.endOfStream();
					s._eos = true;
				} catch(e)  {}
			}

			if (!s._eos) {
				setTimeout(function(){
					s.doEos();
				}, 200);
			}
		}
	}
	
	doAppend () {
		let s = this;
		let appending = false;
		if (!s.sourceBuffer.updating) {
			if (s.queue.length) {
				let buffer = s.queue.shift();
				try {
					s.sourceBuffer.appendBuffer(buffer);
					appending = true;
				} catch(err) {
					s.queue.unshift(buffer);
				}
				
				if (s.queue.length > 10) {
					if (!s.pause) {
						s.pause = true;
						s.socket.emit('pause');
					}
				} else if (s.pause) {
					s.pause = false;
					s.socket.emit('continue');
				}

			}
			
		}
		s.appending = appending;
		
		if (s.queue.length && !appending) {
			setTimeout(function(){
				s.doAppend();
			}, 100);
		}
		
	}
	
	onSBUpdateEnd () {
		let s = this;
		if (!s.queue.length && s.eos && !s.sourceBuffer.updating) {
			s.doEos();
		} else {
			s.doAppend();
		}
		
	}
	
	onSBUpdateError () {
		let s = this;
		s.retry();
		return true;
	}

}
/**
 * Native HTML5 Renderer
 *
 * Wraps the native HTML5 <audio> or <video> tag and bubbles its properties, events, and methods up to the mediaElement.
 */
const VODElement = {
	name: 'vod',
	options: {
		prefix: 'vod'
	},

	/**
	 * Determine if a specific element type can be played with this render
	 *
	 * @param {String} type
	 * @return {String}
	 */
	canPlayType: (type) => {

		const mediaElement = document.createElement('video');

		// Due to an issue on Webkit, force the MP3 and MP4 on Android and consider native support for HLS;
		// also consider URLs that might have obfuscated URLs
		if ((IS_ANDROID && /\/mp(3|4)$/i.test(type)) ||
			(~['application/x-mpegurl', 'vnd.apple.mpegurl', 'audio/mpegurl', 'audio/hls',
			'video/hls'].indexOf(type.toLowerCase()) && SUPPORTS_NATIVE_HLS)) {
			return 'yes';
		} else if (mediaElement.canPlayType) {
			return mediaElement.canPlayType(type.toLowerCase()).replace(/no/, '');
		} else {
			return '';
		}
	},
	/**
	 * Create the player instance and add all native events/methods/properties as possible
	 *
	 * @param {MediaElement} mediaElement Instance of mejs.MediaElement already created
	 * @param {Object} options All the player configuration options passed through constructor
	 * @param {Object[]} mediaFiles List of sources with format: {src: url, type: x/y-z}
	 * @return {Object}
	 */
	create: (mediaElement, options, mediaFiles) => {

		const id = mediaElement.id + '_' + options.prefix;

		let 
			node = null,
			VOD = null; 

		if (mediaElement.originalNode === undefined || mediaElement.originalNode === null) {
			node = document.createElement('audio');
			mediaElement.appendChild(node);
		} else {
			node = mediaElement.originalNode;
		}

		node.setAttribute('id', id);
		VOD = new VODPlayer(node);
		const
			props = mejs.html5media.properties,
			assignGettersSetters = (propName) => {
				const capName = `${propName.substring(0, 1).toUpperCase()}${propName.substring(1)}`;

				node[`get${capName}`] = () => {
					if (VOD != null) {
						switch(propName) {
							case 'src':
								return VOD.getSrc();
							case 'playbackRate':
								return VOD.getPlaybackRate();
							case 'duration':
								return VOD.getDuration();
							case 'currentTime':
								return VOD.getCurrentTime();
							case 'buffered':
								return VOD.getBuffered();
							default:
								return node[propName];
						}
					} else {
						return null;
					}
				};

				node[`set${capName}`] = (value) => {
					if (mejs.html5media.readOnlyProperties.indexOf(propName) === -1) {
						if (VOD != null) {
							switch(propName) {
								case 'src':
									VOD.setSrc(value)
									break;
								case 'playbackRate':
									VOD.setPlaybackRate(value)
									break;
								case 'currentTime':
									VOD.setCurrentTime(value);
									break;
								default:
									node[propName] = value;
									break;
							}
						}
					}
				};
			}
		;

		for (let i = 0, total = props.length; i < total; i++) {
			assignGettersSetters(props[i]);
		}

		const
			events = mejs.html5media.events.concat(['click', 'mouseover', 'mouseout']),
			assignEvents = (eventName) => {
				node.addEventListener(eventName, (e) => {
					if(e.type == 'error') {
						return true;
					} else {
						const event = createEvent(e.type, mediaElement);
						mediaElement.dispatchEvent(event);
					}
				});

			}
		;

		for (let i = 0, total = events.length; i < total; i++) {
			assignEvents(events[i]);
		}

		// HELPER METHODS
		node.setSize = (width, height) => {
			node.style.width = `${width}px`;
			node.style.height = `${height}px`;
			return node;
		};

		node.hide = () => {
			node.style.display = 'none';

			return node;
		};

		node.show = () => {
			node.style.display = '';

			return node;
		};

		if (mediaFiles && mediaFiles.length > 0) {
			for (let i = 0, total = mediaFiles.length; i < total; i++) {
				if (renderer.renderers[options.prefix].canPlayType(mediaFiles[i].type)) {
					VOD.setSrc(mediaFiles[i].src);
					break;
				}
			}
		}

		const event = createEvent('rendererready', node);
		mediaElement.dispatchEvent(event);

		return node;
	}
};

window.VODElement = mejs.VODElement = VODElement;

renderer.add(VODElement);
