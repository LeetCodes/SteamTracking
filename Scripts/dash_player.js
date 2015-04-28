
// Logs messages to the console
function PlayerLog( s )
{
	console.log(s);
};

/////////////////////////////////////////////////////////////////
// DASH video player
/////////////////////////////////////////////////////////////////
function CDASHPlayer( elVideoPlayer )
{
	this.m_elVideoPlayer = elVideoPlayer;
	this.m_strMPD = '';
	this.m_loaders = [];
	this.m_mediaSource = null;
	this.m_rtLiveContentStarted = 0;
	this.m_rtVODResumeAtTime = 0;
	this.m_schUpdateMPD = null;
	this.m_xhrUpdateMPD = null;

	// info used in playback
	this.m_nVideoRepresentationIndex = -1;
	this.m_nAudioRepresentationIndex = 0;
	this.m_nPlayerHeight = 0;
	this.m_nCurrentDownloadBitRate = 0;
	this.m_nSavedPlaybackRate = 1.0;

	// player states
	this.m_bIsBuffering = true;
	this.m_bShouldStayPaused = false;
	this.m_bExiting = false;
	this.m_nCurrentSeekTime = -1;

	// Logging
	this.m_nVideoBuffer = 0;
	this.m_nAudioBuffer = 0;
	this.m_nPlaybackWidth = 0;
	this.m_nPlaybackHeight = 0;
	this.m_nAudioBitRate = 0;
	this.m_nVideoBitRate = 0;
	this.m_nDownloadVideoWidth = 0;
	this.m_nDownloadVideoHeight = 0;
	this.m_bVideoLogVerbose = false;

	// For Server Event Logging
	this.m_nBandwidthTotal = 0;
	this.m_nBandwidthEntries = 0;
	this.m_nBandwidthMinimum = 0;
	this.m_nBandwidthMaximum = 0;

	// Captions
	this.m_VTTCaptionLoader = null;
}

CDASHPlayer.TRACK_BUFFER_MS = 5000;
CDASHPlayer.TRACK_BUFFER_MAX_SEC = 30 * 60;
CDASHPlayer.TRACK_BUFFER_VOD_LOOKAHEAD_MS = 30 * 1000;
CDASHPlayer.DOWNLOAD_RETRY_MS = 500;

CDASHPlayer.HAVE_NOTHING = 0;
CDASHPlayer.HAVE_METADATA = 1;
CDASHPlayer.HAVE_CURRENT_DATA = 2;
CDASHPlayer.HAVE_FUTURE_DATA = 3;
CDASHPlayer.HAVE_ENOUGH_DATA = 4;

CDASHPlayer.prototype.StopDownloads = function()
{
	this.m_bExiting = true;
	for ( var i = 0; i < this.m_loaders.length; i++ )
	{
		this.m_loaders[i].Close();
	}

	if ( this.m_schUpdateMPD )
	{
		clearTimeout( this.m_schUpdateMPD );
		this.m_schUpdateMPD = null;
	}

	if ( this.m_xhrUpdateMPD )
	{
		this.m_xhrUpdateMPD.abort();
		this.m_xhrUpdateMPD = null;
	}
}

CDASHPlayer.prototype.Close = function()
{
	this.StopDownloads();

	this.m_loaders = [];
	if ( this.m_mediaSource )
	{
		$J( this.m_mediaSource ).off( '.DASHPlayerEvents' );
		if ( this.m_mediaSource.readyState != 'closed' )
			this.m_mediaSource.endOfStream();

		this.m_mediaSource = null;
	}

	$J( this.m_elVideoPlayer ).off( '.DASHPlayerEvents' );

	this.m_strMPD = '';
	this.m_rtLiveContentStarted = 0;
	this.m_rtVODResumeAtTime = 0;
	this.m_bIsBuffering = true;
	this.m_bShouldStayPaused = false;
	this.m_nCurrentSeekTime = -1;
	this.m_nSavedPlaybackRate = 1.0;
	this.m_bExiting = false;

	// For Server Event Logging
	this.m_nBandwidthTotal = 0;
	this.m_nBandwidthEntries = 0;
	this.m_nBandwidthMinimum = 0;
	this.m_nBandwidthMaximum = 0;

	if ( this.m_VTTCaptionLoader )
	{
		this.m_VTTCaptionLoader.Close();
		this.m_VTTCaptionLoader = null;
	}
}

CDASHPlayer.prototype.CloseWithError = function()
{
	this.Close();
	$J( this.m_elVideoPlayer ).trigger( 'playbackerror' );
}

CDASHPlayer.prototype.PlayMPD = function( strURL )
{
	this.m_strMPD = strURL;

	// load video player then init & parse
	var _player = this;
	this.m_xhrUpdateMPD = $J.ajax(
	{
		url: strURL,
		type: 'GET'
	})
	.done( function( data, status, xhr )
	{
		_player.m_xhrUpdateMPD = null;
		if ( _player.m_bExiting )
			return;

		// parse MPD file
		_player.m_mpd = new CMPDParser();
		if ( !_player.m_mpd.BParse( data ) )
		{
			PlayerLog( 'Failed to parse MPD file' );
			_player.CloseWithError();
			return;
		}

		// special handling for dynamic content
		if ( _player.BIsLiveContent() )
		{
			// schedule mpd reload
			if ( _player.m_mpd.minimumUpdatePeriod > 0 )
			{
				_player.m_schUpdateMPD = setTimeout( function() { _player.UpdateMPD(); }, _player.m_mpd.minimumUpdatePeriod * 1000 );
			}

			// calculate when the video started relative to system clock
			var strServerTime = xhr.getResponseHeader( 'date' );
			var unServerTime = strServerTime ? new Date( strServerTime ).getTime() : Date.now();
			_player.m_rtLiveContentStarted = Date.now() - (unServerTime - _player.m_mpd.availabilityStartTime.getTime());
			PlayerLog( 'server time: ' + strServerTime );
		}

		// select representation to play
		if ( !_player.BCreateLoaders() )
		{
			PlayerLog( 'Failed to create segment loaders' );
			_player.CloseWithError();
			return;
		}

		// can now init video controls and start playback
		_player.InitVideoControl();
	})
	.fail( function()
	{
		_player.m_xhrUpdateMPD = null;
		PlayerLog( 'Failed to download: ' + _player.m_strMPD );
		_player.CloseWithError();
	});
}

CDASHPlayer.prototype.UpdateMPD = function()
{
	this.m_schUpdateMPD = null;
	if ( this.m_bExiting )
		return;

	// load video player then init & parse
	var _player = this;
	this.m_xhrUpdateMPD = $J.ajax(
	{
		url: _player.m_strMPD,
		type: 'GET'
	})
	.done( function( data, status, xhr )
	{
		_player.m_xhrUpdateMPD = null;
		if ( _player.m_bExiting )
        	return;

		// parse MPD file
		if ( !_player.m_mpd.BUpdate( data ) )
		{
			PlayerLog( 'Failed to update MPD file' );
			_player.CloseWithError();
			return;
		}

		// if dynamic, schedule mpd reload
		if ( _player.BIsLiveContent() && _player.m_mpd.minimumUpdatePeriod > 0 )
			_player.m_schUpdateMPD = setTimeout( function() { _player.UpdateMPD(); }, _player.m_mpd.minimumUpdatePeriod * 1000 );

	})
	.fail( function()
	{
		_player.m_xhrUpdateMPD = null;
		PlayerLog( 'Failed to download: ' + _player.m_strMPD );
		_player.CloseWithError();
	});
}

CDASHPlayer.prototype.BCreateLoaders = function()
{
	// only support 1 period
	if ( this.m_mpd.periods.length == 0 )
		return false;

	var period = this.m_mpd.periods[0];

	var bNeedVideo = true;
	var bNeedAudio = true;
	for ( var i = 0; i < period.adaptationSets.length; i++ )
	{
		var adaptation = period.adaptationSets[i];

		// tracks could be in same adaptation set
		var keep = null;
		if ( bNeedVideo && adaptation.containsVideo )
		{
			keep = adaptation;
			bNeedVideo = false;
		}

		if ( bNeedAudio && adaptation.containsAudio )
		{
			keep = adaptation;
			bNeedAudio = false;
		}

		if ( keep )
		{
			var loader = new CSegmentLoader( this, keep );
			this.m_loaders.push( loader );
		}

		if ( !bNeedVideo && !bNeedAudio )
			break;
	}

	// want to always play video
	return !bNeedVideo;
}

CDASHPlayer.prototype.InitVideoControl = function()
{
	// create the media source
	var mediaSource = new window.MediaSource();
	var mediaURL = URL.createObjectURL(mediaSource);
	this.m_elVideoPlayer.pause();
	this.m_elVideoPlayer.src = mediaURL;
	this.m_mediaSource = mediaSource;

	// need to wait for the source to open then can add buffers
	var _player = this;
	$J( mediaSource ).on( 'sourceopen.DASHPlayerEvents', function() { _player.OnMediaSourceOpen(); });
	$J( mediaSource ).on( 'sourceended.DASHPlayerEvents', function( e ) { _player.OnMediaSourceEnded( e ); });
	$J( mediaSource ).on( 'sourceclose.DASHPlayerEvents', function( e ) { _player.OnMediaSourceClose( e ); });

	$J( this.m_elVideoPlayer ).on( 'progress.DASHPlayerEvents', function() { _player.OnVideoBufferProgress(); });
	$J( this.m_elVideoPlayer ).on( 'stalled.DASHPlayerEvents', function() { _player.OnVideoStalled(); });
}

CDASHPlayer.prototype.OnMediaSourceOpen = function()
{
	for ( var i = 0; i < this.m_loaders.length; i++ )
	{
		this.m_loaders[i].SetMediaSource( this.m_mediaSource );
	}

	this.BeginPlayback();
}

CDASHPlayer.prototype.OnMediaSourceEnded = function( e )
{
	PlayerLog( 'Media source ended' );
}

CDASHPlayer.prototype.OnMediaSourceClose = function( e )
{
		PlayerLog( 'Media source closed' );
	this.CloseWithError();
}

CDASHPlayer.prototype.SetVODResumeTime = function( nTime )
{
	this.m_rtVODResumeAtTime = nTime;
}

CDASHPlayer.prototype.BeginPlayback = function()
{
	var unStartTime = 0;

	if ( this.BIsLiveContent() )
	{
		unStartTime = Date.now() - this.m_rtLiveContentStarted;
	}
	else
	{
		var unVideoDuration = Math.floor( this.m_mpd.GetPeriodDuration(0) ) - ( CDASHPlayer.TRACK_BUFFER_MS / 1000 );
		if ( 0 < this.m_rtVODResumeAtTime && this.m_rtVODResumeAtTime < unVideoDuration )
		{
			unStartTime = this.m_rtVODResumeAtTime * 1000;
		}
	}

	for ( var i = 0; i < this.m_loaders.length; i++ )
	{
		this.m_loaders[i].BeginPlayback( unStartTime );
	}

	$J( this.m_elVideoPlayer ).trigger( 'initialized' );
}

CDASHPlayer.prototype.OnVideoBufferProgress = function()
{
	if ( !this.BIsBuffering() )
		return;

	if ( this.m_nCurrentSeekTime != -1 )
		this.m_elVideoPlayer.currentTime = this.m_nCurrentSeekTime;

	// when all loaders have enough buffered data, play
	var bPlay = ( this.m_loaders.length > 0 );
	var nStartPlayback = ( this.m_nCurrentSeekTime != -1 ) ? this.m_nCurrentSeekTime : 0;
	for ( var i = 0; i < this.m_loaders.length; i++ )
	{
		if ( this.m_loaders[i].m_bSeekInProgress || !this.m_loaders[i].BIsLoaderBuffered() )
		{
			bPlay = false;
			break;
		}

		nStartPlayback = Math.max( nStartPlayback, this.m_loaders[i].GetBufferedStart() );
	}

	if ( bPlay && this.m_elVideoPlayer.readyState != CDASHPlayer.HAVE_NOTHING )
	{
		this.m_bIsBuffering = false;
		this.m_nCurrentSeekTime = -1;

		this.m_elVideoPlayer.currentTime = nStartPlayback;

		if ( !this.m_bShouldStayPaused )
			this.m_elVideoPlayer.play();

		this.m_elVideoPlayer.playbackRate = this.m_nSavedPlaybackRate;

		$J( this.m_elVideoPlayer ).trigger( 'bufferingcomplete' );
	}
}

CDASHPlayer.prototype.OnVideoStalled = function()
{
	if ( !this.BIsBuffering() )
	{
		this.UpdateStats();
		for ( var i = 0; i < this.m_loaders.length; i++ )
		{
			if ( this.m_loaders[i].BIsLoaderStalling() )
			{
				if ( !this.BIsLiveContent() )
					this.SavePlaybackStateForBuffering( this.m_elVideoPlayer.currentTime );

				$J( this.m_elVideoPlayer ).trigger( 'playbackstalled', [ this.m_loaders[i].ContainsVideo() ] );

				break;
			}
		}
	}
}

CDASHPlayer.prototype.OnSegmentDownloaded = function()
{
	this.UpdateStats();
	this.UpdateRepresentation( this.m_nVideoRepresentationIndex, true );
	$J( this.m_elVideoPlayer ).trigger( 'bufferedupdate' );
}

CDASHPlayer.prototype.OnSegmentDownloadFailed = function()
{
		this.StopDownloads();

	$J( this.m_elVideoPlayer ).trigger( 'downloadfailed' );
}

CDASHPlayer.prototype.BIsBuffering = function()
{
	return this.m_bIsBuffering || this.m_elVideoPlayer.readyState == CDASHPlayer.HAVE_NOTHING;
}

CDASHPlayer.prototype.BIsLiveContent = function()
{
	if (this.m_mpd)
	{
		return (this.m_mpd.type == 'dynamic');
	}
	else
	{
		return true;
	}
}

CDASHPlayer.prototype.GetPercentBuffered = function()
{
	var unVideoBuffered = 0;
	var unAudioBuffered = 0 ;

	for ( var i = 0; i < this.m_loaders.length; i++ )
	{
		if ( this.m_loaders[i].m_bSeekInProgress )
			return 0;

		if ( this.m_loaders[i].ContainsVideo() )
		{
			unVideoBuffered = Math.min( this.m_nVideoBuffer * 100 / CDASHPlayer.TRACK_BUFFER_MS, 100 );
		}

		if ( this.m_loaders[i].ContainsAudio() && !this.m_loaders[i].ContainsVideo() )
		{
			unAudioBuffered = Math.min( this.m_nAudioBuffer * 100 / CDASHPlayer.TRACK_BUFFER_MS, 100 );
		}
	}

	return Math.min( unVideoBuffered, unAudioBuffered ).toFixed(0);
}

CDASHPlayer.prototype.GetLiveBufferWindow = function()
{
	return CDASHPlayer.TRACK_BUFFER_MAX_SEC;
}

CDASHPlayer.prototype.SeekToBufferedEnd = function()
{
	var nStartPlayback = null;
	for ( var i = 0; i < this.m_loaders.length; i++ )
	{
		if ( nStartPlayback == null )
		{
			nStartPlayback = this.m_loaders[i].GetBufferedEnd();
			continue;
		}

		nStartPlayback = Math.min( nStartPlayback, this.m_loaders[i].GetBufferedEnd() );
	}

	if ( nStartPlayback == null )
		return;

	nStartPlayback -= (CDASHPlayer.TRACK_BUFFER_MS / 1000 );
	if ( nStartPlayback > 0 )
		this.m_elVideoPlayer.currentTime = nStartPlayback;
}

CDASHPlayer.prototype.SeekTo = function( nTime )
{
	if ( !this.BIsBuffering() )
	{
		var bCanSeekImmediately = true;
		for (var i = 0; i < this.m_loaders.length; i++)
		{
			bCanSeekImmediately &= this.m_loaders[i].SeekToSegment( nTime, false );
		}

		if ( bCanSeekImmediately )
		{
			this.m_elVideoPlayer.currentTime = nTime;
		}
		else
		{
			this.SavePlaybackStateForBuffering( nTime );
		}
	}
}

CDASHPlayer.prototype.SavePlaybackStateForBuffering = function( nSeekTime )
{
	this.m_bShouldStayPaused = this.m_elVideoPlayer.paused;
	this.m_elVideoPlayer.pause();
	this.m_nCurrentSeekTime = nSeekTime;
	this.m_bIsBuffering = true;
}

CDASHPlayer.prototype.GetClosedCaptionsArray = function()
{
	var period = this.m_mpd.periods[0];
	var rgClosedCaptions = [];

	for ( var i = 0; i < period.adaptationSets.length; i++ )
	{
		var adaptation = period.adaptationSets[i];
		if ( adaptation.isClosedCaption )
		{
			var language = {
				code: adaptation.language,
				display: adaptation.language,
				url: adaptation.representations[0].closedCaptionFile,
			};

			for ( lang in CVTTCaptionLoader.LanguageCountryCodes )
			{
				if ( lang.toUpperCase() == language.code.toUpperCase() )
				{
					language.display = CVTTCaptionLoader.LanguageCountryCodes[lang].displayName;

										if ( language.display.indexOf( String.fromCharCode( 0x28 ) ) != -1 )
						language.display = language.display.substring( 0, language.display.indexOf( String.fromCharCode( 0x28 ) ) - 1 );
					else if ( language.display.indexOf( String.fromCharCode( 0xFF08 ) ) != -1 )
						language.display = language.display.substring( 0, language.display.indexOf( String.fromCharCode( 0xFF08 ) ) );
				}
			}

			rgClosedCaptions.push(language);
		}
	}

	return rgClosedCaptions.sort(CVTTCaptionLoader.SortClosedCaptionsByDisplayLanguage);
}

CDASHPlayer.prototype.GetRepresentationsArray = function ( bVideo )
{
	var rgRespresentations = [];

	if ( this.m_loaders )
	{
		for (var i = 0; i < this.m_loaders.length; i++)
		{
			if ( bVideo && this.m_loaders[i].ContainsVideo() )
			{
				for (var b = 0; b < this.m_loaders[i].GetRepresentationsCount(); b++)
				{
					var representation = {
						height: 0,
						bandwidth: 0,
					};

					if (this.m_loaders[i].m_adaptation.representations[b].height != null)
					{
						representation.height = this.m_loaders[i].m_adaptation.representations[b].height;
					}
					else
					{
						representation.bandwidth = b;
					}

					representation.bandwidth = this.m_loaders[i].m_adaptation.representations[b].bandwidth;

					rgRespresentations.push( representation );
				}
			}
			else if ( !bVideo && this.m_loaders[i].ContainsAudio() )
			{
				for (var b = 0; b < this.m_loaders[i].GetRepresentationsCount(); b++)
				{
					var representation = {
						audioChannels: this.m_loaders[i].m_adaptation.representations[b].audioChannels,
						bandwidth: this.m_loaders[i].m_adaptation.representations[b].bandwidth,
					}

					rgRespresentations.push( representation );
				}
			}
		}
	}

	return rgRespresentations;
}

CDASHPlayer.prototype.UpdateRepresentation = function ( representationIndex, bVideo )
{
	// if specific bit rate and no change will occur, short circuit and get out
	if ( ( bVideo && representationIndex >= 0 && this.m_nVideoRepresentationIndex == representationIndex ) ||
	   (  !bVideo && this.m_nAudioRepresentationIndex == representationIndex ) )
		return;

	if ( representationIndex == -1 )
	{
		// don't automatically shift bit rates while waiting on the player
		if ( this.BIsBuffering() )
			return;

		// Adaptive Video Change
		for (var i = 0; i < this.m_loaders.length; i++)
		{
			var newRepresentationIndex = this.m_loaders[i].GetRepresentationsCount() - 1;

			if ( this.m_loaders[i].ContainsVideo() )
			{
				var nMaxRepresentations = this.m_loaders[i].GetRepresentationsCount() - 1;

				// if we find there is only one representation, update to not-adaptive and get out
				if (nMaxRepresentations == 0)
				{
					this.m_nVideoRepresentationIndex = newRepresentationIndex;
					break;
				}

				for (var b = nMaxRepresentations; b >= 0; b--)
				{
					// proposed new video bit rate + current audio bit rate modified by playback rate, plus 20% overhead
					var nRequiredBitRate = ( ( this.m_loaders[i].m_adaptation.representations[b].bandwidth + this.m_nAudioBitRate ) * this.m_elVideoPlayer.playbackRate ) * 1.2;
					if ( this.m_nCurrentDownloadBitRate >= nRequiredBitRate )
					{
						if (this.m_loaders[i].m_adaptation.representations[b].height != null)
						{
							// and player height needs to be more than the video height of the smaller representation (e.g. 800 height should use 1080, not 720)
							if ( this.m_nPlayerHeight >= this.m_loaders[i].m_adaptation.representations[ Math.min( b+1, nMaxRepresentations ) ].height )
							{
								newRepresentationIndex = b;
							}
						}
						else
						{
							// no defined height, then ok
							newRepresentationIndex = b;
						}
					}
				}

				// change representation, record now in adaptive rate.
				this.m_nVideoRepresentationIndex = -1;
				this.m_loaders[i].ChangeRepresentationByIndex(newRepresentationIndex);
				break;
			}
		}
	}
	else
	{
		// Specific representation and bit rate
		for (var i = 0; i < this.m_loaders.length; i++)
		{
			if ( bVideo && this.m_loaders[i].ContainsVideo() )
			{
				this.m_nVideoRepresentationIndex = representationIndex;
				this.m_loaders[i].ChangeRepresentationByIndex( this.m_nVideoRepresentationIndex );
				this.m_loaders[i].SeekToSegment( this.m_elVideoPlayer.currentTime, true );
			}
			else if (!bVideo && this.m_loaders[i].ContainsAudio())
			{
				this.m_nAudioRepresentationIndex = representationIndex;
				this.m_loaders[i].ChangeRepresentationByIndex( this.m_nAudioRepresentationIndex );
				this.m_loaders[i].SeekToSegment( this.m_elVideoPlayer.currentTime, true );
			}
		}

		this.SavePlaybackStateForBuffering( this.m_elVideoPlayer.currentTime );
	}
}

CDASHPlayer.prototype.UpdateClosedCaption = function ( closedCaptionCode )
{
	if ( !this.m_VTTCaptionLoader )
	{
		this.m_VTTCaptionLoader = new CVTTCaptionLoader( this.m_elVideoPlayer, this.GetClosedCaptionsArray() );
	}

	this.m_VTTCaptionLoader.SwitchToTextTrack( closedCaptionCode );
}

CDASHPlayer.prototype.SetPlaybackRate = function ( unRate )
{
	if ( unRate )
		this.m_elVideoPlayer.playbackRate = this.m_nSavedPlaybackRate = unRate;
}

CDASHPlayer.prototype.GetPlaybackRate = function()
{
	return this.m_elVideoPlayer.playbackRate;
}

CDASHPlayer.prototype.GetPlaybackTimeInSeconds = function()
{
	return parseInt( this.m_elVideoPlayer.currentTime );
}

CDASHPlayer.prototype.GetLanguageForAudioTrack = function()
{
	for ( var i = 0; i < this.m_loaders.length; i++ )
	{
		if ( this.m_loaders[i].ContainsAudio() )
		{
			return this.m_loaders[i].m_adaptation.language;
		}
	}

	return null;
}

CDASHPlayer.prototype.GetThumbnailInfoForVideo = function()
{
	for ( var i = 0; i < this.m_loaders.length; i++ )
	{
		if ( this.m_loaders[i].ContainsVideo() )
		{
			if ( this.m_loaders[i].m_adaptation.thumbnails )
				return this.m_loaders[i].m_adaptation.thumbnails;
		}
	}

	return null;
}

CDASHPlayer.prototype.BPlayingAudio = function()
{
	for ( var i = 0; i < this.m_loaders.length; i++ )
	{
		if ( this.m_loaders[i].ContainsAudio() )
			return true;
	}

	return false;
}

CDASHPlayer.prototype.UpdateStats = function()
{
	this.m_nCurrentDownloadBitRate = 0;
	var nBandwidthCount = 0;

	for (var i = 0; i < this.m_loaders.length; i++)
	{
		if (this.m_loaders[i].ContainsVideo())
		{
			// logging
			this.m_nVideoBuffer = this.m_loaders[i].GetAmountBufferedInPlayer();
			this.m_nPlaybackWidth = this.m_elVideoPlayer.videoWidth;
			this.m_nPlaybackHeight = this.m_elVideoPlayer.videoHeight;
			this.m_nVideoBitRate = this.m_loaders[i].m_representation.bandwidth;
			this.m_nDownloadVideoWidth = (this.m_loaders[i].m_representation.width != null) ? this.m_loaders[i].m_representation.width : 0;
			this.m_nDownloadVideoHeight = (this.m_loaders[i].m_representation.height != null) ? this.m_loaders[i].m_representation.height : 0;

			// used for playback
			this.m_nPlayerHeight = $J(this.m_elVideoPlayer.parentNode).height();
			this.m_nCurrentDownloadBitRate += this.m_loaders[i].GetBandwidthRate();
			nBandwidthCount++;
		}

		if (this.m_loaders[i].ContainsAudio())
		{
			this.m_nAudioBuffer = this.m_loaders[i].GetAmountBufferedInPlayer();

			// if a muxed audio stream, mark audio bitrate as zero
			// otherwise bandwidth needed will be calculated as double.
			if (this.m_loaders[i].ContainsVideo())
			{
				this.m_nAudioBitRate = 0;
			}
			else
			{
				this.m_nAudioBitRate = this.m_loaders[i].m_representation.bandwidth;
				this.m_nCurrentDownloadBitRate += this.m_loaders[i].GetBandwidthRate();
				nBandwidthCount++;
			}
		}
	}

	// Get average download rate across all loaders
	if ( nBandwidthCount > 1 )
	{
		this.m_nCurrentDownloadBitRate /= nBandwidthCount;
	}

	// For Server Event Logging
	this.m_nBandwidthTotal += this.m_nCurrentDownloadBitRate;
	this.m_nBandwidthEntries++;
	this.m_nBandwidthMinimum = ( this.m_nBandwidthMinimum == 0 ? this.m_nCurrentDownloadBitRate : ( this.m_nCurrentDownloadBitRate < this.m_nBandwidthMinimum ? this.m_nCurrentDownloadBitRate : this.m_nBandwidthMinimum ) );
	this.m_nBandwidthMaximum = ( this.m_nBandwidthMaximum == 0 ? this.m_nCurrentDownloadBitRate : ( this.m_nCurrentDownloadBitRate > this.m_nBandwidthMaximum ? this.m_nCurrentDownloadBitRate : this.m_nBandwidthMaximum ) );
}

CDASHPlayer.prototype.StatsVideoBuffer = function()
{
	return (this.m_nVideoBuffer / 1000).toFixed(2);
}

CDASHPlayer.prototype.StatsAudioBuffer = function()
{
	return (this.m_nAudioBuffer / 1000).toFixed(2);
}

CDASHPlayer.prototype.StatsPlaybackWidth = function()
{
	return this.m_nPlaybackWidth;
}

CDASHPlayer.prototype.StatsPlaybackHeight = function()
{
	return this.m_nPlaybackHeight;
}

CDASHPlayer.prototype.StatsAudioBitRate = function()
{
	return (this.m_nAudioBitRate / 1000).toFixed(2);
}

CDASHPlayer.prototype.StatsVideoBitRate = function()
{
	return (this.m_nVideoBitRate / 1000).toFixed(2);
}

CDASHPlayer.prototype.StatsAudioChannels = function()
{
	for (var i = 0; i < this.m_loaders.length; i++)
	{
		if ( this.m_loaders[i].ContainsAudio() && this.m_loaders[i].m_representation.audioChannels )
		{
			return this.m_loaders[i].m_representation.audioChannels;
		}
	}

	return 0;
}

CDASHPlayer.prototype.StatsDownloadVideoWidth = function()
{
	return this.m_nDownloadVideoWidth;
}

CDASHPlayer.prototype.StatsDownloadVideoHeight = function()
{
	return this.m_nDownloadVideoHeight;
}

CDASHPlayer.prototype.StatsCurrentDownloadBitRate = function()
{
	return (this.m_nCurrentDownloadBitRate / 1000).toFixed(2);
}

CDASHPlayer.prototype.StatsBufferInfo = function()
{
	var bufferString = "";

	for (var i = 0; i < this.m_loaders.length; i++)
	{
		if ( !this.m_loaders[i].m_sourceBuffer )
			continue;

		if ( this.m_loaders[i].ContainsVideo() )
		{
			for (var v = 0; v < this.m_loaders[i].m_sourceBuffer.buffered.length; v++)
			{
				bufferString += "Video Buffer " + v + ": " + SecondsToTime(this.m_loaders[i].m_sourceBuffer.buffered.start(v)) + " - " + SecondsToTime(this.m_loaders[i].m_sourceBuffer.buffered.end(v)) + "<br>";
			}
		}

		if ( this.m_loaders[i].ContainsAudio() )
		{
			for (var a = 0; a < this.m_loaders[i].m_sourceBuffer.buffered.length; a++)
			{
				bufferString += "Audio Buffer " + a + ": " + SecondsToTime(this.m_loaders[i].m_sourceBuffer.buffered.start(a)) + " - " + SecondsToTime(this.m_loaders[i].m_sourceBuffer.buffered.end(a)) + "<br>";
			}
		}
	}

	if (bufferString == "")
		bufferString = "No Buffers";

	return bufferString;
}

CDASHPlayer.prototype.StatsProperties = function()
{
	return "Error: " + ( (this.m_elVideoPlayer.error) ? this.m_elVideoPlayer.error.code : "None" ) + ", Network: " + this.m_elVideoPlayer.networkState;
}

CDASHPlayer.prototype.StatsSegmentInfo = function()
{
	var bufferString = "";
	for (var i = 0; i < this.m_loaders.length; i++)
	{
		if (this.m_loaders[i].ContainsVideo())
		{
			bufferString += "Video " + (this.m_loaders[i].m_nNextSegment);
			if (!this.BIsLiveContent())
				bufferString += "/" + (this.m_loaders[i].m_nTotalSegments );
			bufferString += ", ";
		}

		if (this.m_loaders[i].ContainsAudio())
		{
			bufferString += "Audio " + (this.m_loaders[i].m_nNextSegment);
			if (!this.BIsLiveContent())
				bufferString += "/" + (this.m_loaders[i].m_nTotalSegments );
			bufferString += " ";
		}
	}

	return bufferString;
}

CDASHPlayer.prototype.StatsDownloadHost = function()
{
	for (var i = 0; i < this.m_loaders.length; i++)
	{
		if ( this.m_loaders[i].ContainsVideo() )
		{
			var parser = document.createElement('a');
			parser.href = CMPDParser.GetInitSegmentURL( this.m_loaders[i].m_adaptation, this.m_loaders[i].m_representation );
			return parser.hostname;
		}
	}
	
	return '';
}

CDASHPlayer.prototype.StatsAllBytesReceived = function()
{
	var bytes = 0;
	for (var i = 0; i < this.m_loaders.length; i++)
	{
		bytes += this.m_loaders[i].GetBytesReceived();
	}
	
	return bytes;
}

CDASHPlayer.prototype.StatsAllFailedSegmentDownloads = function()
{
	var segments = 0;
	for (var i = 0; i < this.m_loaders.length; i++)
	{
		segments += this.m_loaders[i].GetFailedSegmentDownloads();
	}
	
	return segments;
}

CDASHPlayer.prototype.StatsBandwidthRates = function( bResetStats )
{
	var bw_stats = {};

	if ( this.m_nBandwidthEntries > 0 )
	{
		bw_stats = {
			'bw_avg': this.m_nBandwidthTotal / this.m_nBandwidthEntries,
			'bw_min': this.m_nBandwidthMinimum,
			'bw_max': this.m_nBandwidthMaximum,
		}
	}
	else
	{
		bw_stats = {
			'bw_avg': 0,
			'bw_min': 0,
			'bw_max': 0,
		}
	}

	if ( bResetStats )
	{
		this.m_nBandwidthTotal = 0;
		this.m_nBandwidthEntries = 0;
		this.m_nBandwidthMinimum = 0;
		this.m_nBandwidthMaximum = 0;
	}

	return bw_stats;
}

CDASHPlayer.prototype.StatsSegmentDownloadTimes = function( bResetStats )
{
	for (var i = 0; i < this.m_loaders.length; i++)
	{
		// for now, just video download time stats
		if ( this.m_loaders[i].ContainsVideo() )
			return this.m_loaders[i].GetSegmentDownloadTimeStats( bResetStats );
	}

	return {
		'seg_avg': 0,
		'seg_min': 0,
		'seg_max': 0,
	};
}

CDASHPlayer.prototype.StatsRecentSegmentDownloads = function( bVideo )
{
	var stats = {
		'last_segment_number': 0,
		'last_segment_response': 200
	};

	for (var i = 0; i < this.m_loaders.length; i++)
	{
		if ( bVideo && this.m_loaders[i].ContainsVideo() ||
			!bVideo && !this.m_loaders[i].ContainsVideo() && this.m_loaders[i].ContainsAudio() )
		{
			var downloadLog = this.m_loaders[i].GetDownloadLog();
			stats['last_segment_number'] = this.m_loaders[i].m_nNextSegment - 1;
			stats['last_segment_response'] = this.m_loaders[i].m_nLastSegmentDownloadStatus;

			var segNum = 1;
			for ( var l = downloadLog.length - 1; l >= 0; l-- )
			{
				stats['segment' + segNum + '_bytes'] = downloadLog[l].dataSizeBytes;
				stats['segment' + segNum + '_time'] = downloadLog[l].downloadTime / 1000;

				if ( ++segNum > 3 )
					break;
			}

			break;
		}
	}

	return stats;
}

CDASHPlayer.prototype.BLogVideoVerbose = function()
{
	return this.m_bVideoLogVerbose;
}

/////////////////////////////////////////////////////////////////
// Segment loader. Responsible for downloading and loading video player buffers
/////////////////////////////////////////////////////////////////
function CSegmentLoader( player, adaptationSet )
{
	this.m_player = player;
	this.m_mediaSource = null;
	this.m_sourceBuffer = null;

	this.m_adaptation = adaptationSet;
	this.m_representation = null;

	this.m_nBufferUpdate = CSegmentLoader.s_BufferUpdateNone;
	this.m_bufSegments = [];
	this.m_bNeedInitSegment = true;
	this.m_nNextSegment = 0;
	this.m_nTotalSegments = Number.MAX_VALUE;
	this.m_bRemoveBufferState = false;
	this.m_bSeekInProgress = false;

	// need to be closed
	this.m_xhr = null;
	this.m_schNextDownload = null;
	this.m_schRetryDownload = null;
	this.m_schWaitForBuffer = null;

	// bandwidth monitoring
	this.m_rgDownloadLog = [];
	this.m_nDownloadLogSize = 4;

	// for stats tracking
	this.m_nBytesReceivedTotal = 0;
	this.m_nFailedSegmentDownloads = 0;
	this.m_nSegmentDownloadTimeTotal = 0;
	this.m_nSegmentDownloadTimeEntries = 0;
	this.m_nSegmentDownloadTimeMinimum = 0;
	this.m_nSegmentDownloadTimeMaximum = 0;
	this.m_nLastSegmentDownloadStatus = 200;
}

CSegmentLoader.s_BufferUpdateNone = 0;
CSegmentLoader.s_BufferUpdateAppend = 1;
CSegmentLoader.s_BufferUpdateRemove = 2;

CSegmentLoader.PIPELINE_NEXT_SEGMENT = true;
CSegmentLoader.PIPELINE_RANGE_BYTES = 128;

CSegmentLoader.prototype.Close = function()
{
	if ( this.m_sourceBuffer )
	{
		$J( this.m_sourceBuffer ).off( '.SegmentLoaderEvents' );
		this.m_sourceBuffer = null;
	}

	if ( this.m_xhr )
	{
		this.m_xhr.abort();
		this.m_xhr = null;
	}

	if ( this.m_schNextDownload )
	{
		clearTimeout( this.m_schNextDownload );
		this.m_schNextDownload = null;
	}

	if ( this.m_schRetryDownload )
	{
		clearTimeout( this.m_schRetryDownload );
		this.m_schRetryDownload = null;
	}

	if ( this.m_schWaitForBuffer )
	{
		clearTimeout( this.m_schWaitForBuffer );
		this.m_schWaitForBuffer = null;
	}

	this.m_player = null;
	this.m_mediaSource = null;
	this.m_sourceBuffer = null;

	this.m_adaptation = null;
	this.m_representation = null;

	this.m_nBufferUpdate = CSegmentLoader.s_BufferUpdateNone;
	this.m_bufSegments = [];
	this.m_bNeedInitSegment = true;
	this.m_nNextSegment = 0;
	this.m_nTotalSegments = Number.MAX_VALUE;
	this.m_bRemoveBufferState = false;
	this.m_bSeekInProgress = false;

	// need to be closed
	this.m_xhr = null;
	this.m_schNextDownload = null;
	this.m_schRetryDownload = null;
	this.m_schWaitForBuffer = null;

	// for stats tracking
	this.m_nBytesReceivedTotal = 0;
	this.m_nFailedSegmentDownloads = 0;
	this.m_nSegmentDownloadTimeTotal = 0;
	this.m_nSegmentDownloadTimeEntries = 0;
	this.m_nSegmentDownloadTimeMinimum = 0;
	this.m_nSegmentDownloadTimeMaximum = 0;
	this.m_nLastSegmentDownloadStatus = 200;
}

CSegmentLoader.prototype.ContainsVideo = function()
{
	if ( this.m_adaptation )
		return this.m_adaptation.containsVideo;
	else
		return false;
}

CSegmentLoader.prototype.ContainsAudio = function()
{
	if ( this.m_adaptation )
		return this.m_adaptation.containsAudio;
	else
		return false;
}

CSegmentLoader.prototype.SetMediaSource = function( mediaSource )
{
	this.m_mediaSource = mediaSource;
}

CSegmentLoader.prototype.GetRepresentationsCount = function()
{
	return this.m_adaptation.representations.length;
}

CSegmentLoader.prototype.GetTotalSegments = function()
{
	// Calculate total segments if appropriate
	if (this.m_player.m_mpd.periods[0].duration)
	{
		// asking for segment after end of video, so - 1 for actual segment count
		this.m_nTotalSegments = CMPDParser.GetSegmentForTime( this.m_adaptation, this.m_player.m_mpd.periods[0].duration * 1000 ) - 1;
	}

	return this.m_nTotalSegments;
}

CSegmentLoader.prototype.BeginPlayback = function( unStartTime )
{
	var nRepCounts = this.GetRepresentationsCount();
	if ( !nRepCounts )
		return false;

	this.GetTotalSegments();

	if ( this.ContainsVideo() )
	{
		this.m_nNextSegment = CMPDParser.GetSegmentForTime( this.m_adaptation, unStartTime );
		PlayerLog( 'Video Stream Starting at: ' + SecondsToTime( unStartTime / 1000 ) + ', starting segment: ' + this.m_nNextSegment );

		// start at 1 better than lowest quality if possible
		if ( nRepCounts > 1 )
			this.ChangeRepresentationByIndex( nRepCounts - 2 );
		else
			this.ChangeRepresentationByIndex( 0 );

		this.DownloadNextSegment();

	}
	else if ( this.ContainsAudio() && !this.ContainsVideo())
	{
		// alternate audio stream
		this.m_nNextSegment = CMPDParser.GetSegmentForTime( this.m_adaptation, unStartTime );
		PlayerLog( 'Audio Stream Starting at: ' + SecondsToTime( unStartTime / 1000 ) + ', starting segment: ' + this.m_nNextSegment );

		this.ChangeRepresentationByIndex( 0 );
		this.DownloadNextSegment();
	}
}

CSegmentLoader.prototype.ChangeRepresentation = function( representation )
{
	var _loader = this;
	this.m_representation = representation;
	this.m_bNeedInitSegment = true;

	if ( !this.m_sourceBuffer )
	{
		this.m_sourceBuffer = this.m_mediaSource.addSourceBuffer( representation.mimeType + ';codecs=' + representation.codecs );
		//PlayerLog( representation.mimeType + ';codecs=' + representation.codecs );
		$J( this.m_sourceBuffer ).on( 'updateend.SegmentLoaderEvents', function() { _loader.OnSourceBufferUpdateEnd() } );
		$J( this.m_sourceBuffer ).on( 'error.SegmentLoaderEvents', function( e ) { _loader.OnSourceBufferError( e ) } );
		$J( this.m_sourceBuffer ).on( 'abort.SegmentLoaderEvents', function( e ) { _loader.OnSourceBufferAbort( e ) } );
	}
}

CSegmentLoader.prototype.ChangeRepresentationByIndex = function( representationIndex )
{
	if ( representationIndex >= 0 && representationIndex < this.GetRepresentationsCount()
		&& this.m_representation != this.m_adaptation.representations[representationIndex] )
	{
		// PlayerLog( ( this.ContainsVideo() ? "Video" : "Audio" ) + " Changing Representation to " + Math.ceil( this.m_adaptation.representations[representationIndex].bandwidth / 1000 ) + 'Kb at Segment ' + this.m_nNextSegment );
		this.ChangeRepresentation( this.m_adaptation.representations[representationIndex] );
	}
}

CSegmentLoader.prototype.DownloadSegment = function( url, nSegmentDuration, rtAttemptStarted )
{
	this.m_schRetryDownload = null;
	if ( !rtAttemptStarted )
		rtAttemptStarted = Date.now();

	// VOD ended if the segment about to be downloaded is more than the total segments
	if ( ( this.m_nNextSegment - 1 ) > this.m_nTotalSegments )
	{
		// PlayerLog ( this.ContainsVideo() ? "Video" : "Audio" ) ;
		// PlayerLog ( this.m_sourceBuffer.buffered.end(0) );

		if ( this.ContainsVideo() )
			$J( this.m_player.m_elVideoPlayer ).trigger( 'voddownloadcomplete' );

		return;
	}

	// PlayerLog( Date.now() + ' downloading: ' + url );

	var _loader = this;
	var xhr = new XMLHttpRequest();
	this.m_xhr = xhr;
	xhr.open( 'GET', url );
	xhr.send();
	xhr.responseType = 'arraybuffer';

	var rtDownloadStart = new Date().getTime();
	try
	{
		xhr.addEventListener( 'readystatechange', function ()
		{
			if ( xhr.readyState == xhr.DONE )
			{
				if ( _loader.m_xhr == null )
					return;

				var now = Date.now();
				var nDownloadMS = now - rtDownloadStart;

				_loader.m_xhr = null;
				_loader.m_nLastSegmentDownloadStatus = xhr.status;

				if ( xhr.status != 200 || !xhr.response )
				{
					_loader.m_nFailedSegmentDownloads++;

					PlayerLog( '[video] HTTP ' + xhr.status + ' (' + nDownloadMS + 'ms, ' + + '0k): ' + url );
					var nTimeToRetry = CDASHPlayer.DOWNLOAD_RETRY_MS;
					if ( _loader.m_player.BIsLiveContent() )
						nTimeToRetry += CDASHPlayer.TRACK_BUFFER_MS;
					else
						nTimeToRetry += CDASHPlayer.TRACK_BUFFER_VOD_LOOKAHEAD_MS;

					if ( now - rtAttemptStarted > nTimeToRetry )
					{
						_loader.DownloadFailed();
						return;
					}

					_loader.m_schRetryDownload = setTimeout( function() { _loader.DownloadSegment( url, nSegmentDuration, rtAttemptStarted ); }, CDASHPlayer.DOWNLOAD_RETRY_MS );
					return;
				}

				try
				{
					var arr = new Uint8Array( xhr.response );
					var segment = {};
					segment.duration = nSegmentDuration;
					segment.data = arr;
					_loader.m_bufSegments.push( segment );

					_loader.LogDownload( xhr, rtDownloadStart, segment.data.length );

					if ( _loader.m_player.BLogVideoVerbose() )
					{
						var nSize = segment.data.length / 1000;
						PlayerLog( '[video] HTTP ' + xhr.status + ' (' + nDownloadMS + 'ms, ' + Math.floor( nSize ) + 'k): ' + url );
					}
				}
				catch (e)
				{
					PlayerLog('Exception while appending: ' + e);
				}

				_loader.UpdateBuffer();
				_loader.ScheduleNextDownload();
			}
		}, false);
	}
	catch ( e )
	{
		PlayerLog( 'Failed to download segment: ' + e );
		return;
	}

	// Hint to the CDN to get the next segment ready for download
	if ( CSegmentLoader.PIPELINE_NEXT_SEGMENT && !this.m_player.BIsLiveContent() && this.m_nNextSegment < this.m_nTotalSegments )
	{
		urlNext = CMPDParser.GetSegmentURL( this.m_adaptation, this.m_representation, this.m_nNextSegment );
		var xmlhttp = new XMLHttpRequest();
		xmlhttp.open( "GET" , urlNext );
		xmlhttp.setRequestHeader( "Range", "bytes=0-" + parseInt( CSegmentLoader.PIPELINE_RANGE_BYTES - 1) );
		xmlhttp.send();
	}
}

CSegmentLoader.prototype.DownloadNextSegment = function()
{
	this.m_schNextDownload = null;

	var url = '';
	var nSegmentDuration = 0;
	if ( this.m_bNeedInitSegment )
	{
		this.m_bNeedInitSegment = false;
		url = CMPDParser.GetInitSegmentURL( this.m_adaptation, this.m_representation );
		nSegmentDuration = 0;
	}
	else
	{
		url = CMPDParser.GetSegmentURL( this.m_adaptation, this.m_representation, this.m_nNextSegment );
		nSegmentDuration = CMPDParser.GetSegmentDuration( this.m_adaptation );
		this.m_nNextSegment++;
	}

	this.DownloadSegment( url, nSegmentDuration );
}

CSegmentLoader.prototype.UpdateBuffer = function()
{
	if ( this.m_nBufferUpdate != CSegmentLoader.s_BufferUpdateNone )
		return;

	if ( this.m_bRemoveBufferState )
	{
		this.RemoveAllBuffers();
	}

	// first add any queued buffers
	if ( this.m_bufSegments.length > 0 )
	{
		this.m_nBufferUpdate = CSegmentLoader.s_BufferUpdateAppend;
		var segment = this.m_bufSegments[0];
		this.m_bufSegments.splice( 0, 1 );
		this.m_sourceBuffer.appendBuffer( segment.data );
	}
	else
	{
		// check to see if we should remove any data
		buffered = (this.m_sourceBuffer != null) ? this.m_sourceBuffer.buffered : {};
		if ( buffered.length > 0 && (buffered.end( 0 ) - buffered.start( 0 )) > CDASHPlayer.TRACK_BUFFER_MAX_SEC )
		{
			var nStart = Math.max( 0, buffered.start(0) - 1 );
			var nEnd = buffered.end(0) - CDASHPlayer.TRACK_BUFFER_MAX_SEC;

			// if playback is within this range, need to advance forward
			var nCurrentTime = this.m_player.m_elVideoPlayer.currentTime;
			if ( !this.m_player.m_elVideoPlayer.paused )
			{
				nEnd = Math.min( nEnd, nCurrentTime - 0.1 );
			}
			else if ( nCurrentTime > nStart && nCurrentTime < nEnd )
			{
				this.m_player.SeekTo( nEnd + 0.1 );
			}

			if ( nEnd > nStart )
			{
				this.m_nBufferUpdate = CSegmentLoader.s_BufferUpdateRemove;
				this.m_sourceBuffer.remove( nStart, nEnd );
			}
		}
	}
}

CSegmentLoader.prototype.OnSourceBufferUpdateEnd = function()
{
	if ( this.m_nBufferUpdate == CSegmentLoader.s_BufferUpdateRemove && this.m_bSeekInProgress )
		this.m_bSeekInProgress = false;

	if ( this.m_nBufferUpdate == CSegmentLoader.s_BufferUpdateAppend )
		this.m_player.OnSegmentDownloaded();

	this.m_nBufferUpdate = CSegmentLoader.s_BufferUpdateNone;
	this.UpdateBuffer();
}

CSegmentLoader.prototype.OnSourceBufferError = function( e )
{
	PlayerLog( 'Source buffer error' );
}

CSegmentLoader.prototype.OnSourceBufferAbort = function( e )
{
	PlayerLog( 'Source buffer update aborted' );
}

CSegmentLoader.prototype.DownloadFailed = function()
{
	this.m_player.OnSegmentDownloadFailed();
}

CSegmentLoader.prototype.ScheduleNextDownload = function()
{
	var _loader = this;
	if ( this.m_bNeedInitSegment )
	{
		this.DownloadNextSegment();
		return;
	}

	// make sure we aren't already scheduled
	if ( this.m_schNextDownload != null )
	{
		PlayerLog( 'Already scheduled next download' );
		return;
	}

	// check if the next segment is available
	var unDeltaMS = CMPDParser.GetSegmentAvailableFromNow( this.m_adaptation, this.m_nNextSegment, this.m_player.m_rtLiveContentStarted );
	if ( unDeltaMS > 0 )
	{
		// not yet available
		this.m_schNextDownload = setTimeout( function() { _loader.DownloadNextSegment() }, unDeltaMS );
		return;
	}

	// check if we need to buffer. Keep downloading for dynamic content, minimum amount for VOD
	var unAmountBuffered = this.GetAmountBuffered();
	if ( this.m_player.BIsLiveContent() || unAmountBuffered < CDASHPlayer.TRACK_BUFFER_MS )
	{
		this.DownloadNextSegment();
		return;
	}

	// if enough to play, but not fully buffered, download with delay to allow adaptive changes to occur
	if ( unAmountBuffered < CDASHPlayer.TRACK_BUFFER_VOD_LOOKAHEAD_MS )
	{
		this.m_schNextDownload = setTimeout( function() { _loader.DownloadNextSegment() }, CDASHPlayer.DOWNLOAD_RETRY_MS );
		return;
	}

	// next segment is available but buffer is full. Can wait on download
	unDeltaMS = unAmountBuffered - CDASHPlayer.TRACK_BUFFER_VOD_LOOKAHEAD_MS;

	if ( this.m_player.m_elVideoPlayer.playbackRate > 1.0 )
		unDeltaMS /= this.m_player.m_elVideoPlayer.playbackRate;

	if ( unAmountBuffered < ( CDASHPlayer.TRACK_BUFFER_MAX_SEC * 1000 ) - CDASHPlayer.TRACK_BUFFER_VOD_LOOKAHEAD_MS )
	{
		// should be room in buffer in TRACK_BUFFER_MS time for next segment
		this.m_schNextDownload = setTimeout( function() { _loader.DownloadNextSegment() }, unDeltaMS );
	}
	else
	{
		// no more room in buffer, don't download now. Check again soon.
		this.m_schWaitForBuffer = setTimeout( function() { _loader.ScheduleNextDownload() }, unDeltaMS );
	}
}

CSegmentLoader.prototype.BIsLoaderStalling = function()
{
	return ( this.GetAmountBufferedInPlayer() < CMPDParser.GetSegmentDuration( this.m_adaptation ) && ( this.m_nNextSegment <= this.m_nTotalSegments ) );
}

CSegmentLoader.prototype.BIsLoaderBuffered = function()
{
	return ( this.GetAmountBufferedInPlayer() >= CDASHPlayer.TRACK_BUFFER_MS || this.m_nNextSegment > this.m_nTotalSegments );
}

CSegmentLoader.prototype.GetAmountBufferedInPlayer = function()
{
	var nBuffered = 0;
	var buffered = {};
	buffered = (this.m_sourceBuffer != null) ? this.m_sourceBuffer.buffered : {};

	if ( buffered.length > 0 )
	{
		// playback might not have started yet so need to ensure it is within the buffered area
		var nCurrentTime = this.m_player.m_elVideoPlayer.currentTime;
		if ( nCurrentTime < buffered.start( 0 ) )
			nCurrentTime = buffered.start( 0 );

		if ( nCurrentTime > buffered.end( 0 ) )
			nCurrentTime = buffered.end( 0 );

		nBuffered = buffered.end( 0 ) - nCurrentTime;
	}

	return Math.floor( nBuffered * 1000 );
}

CSegmentLoader.prototype.GetAmountBuffered = function()
{
	// include data we haven't fed to player
	var nBuffered = this.GetAmountBufferedInPlayer();
   	for ( var i = 0; i < this.m_bufSegments.length; i++ )
	{
		nBuffered += this.m_bufSegments[i].duration;
	}
	return nBuffered;
}

CSegmentLoader.prototype.GetBufferedStart = function()
{
	var buffered = this.m_sourceBuffer.buffered;
	if ( buffered.length == 0 )
		return 0;

	return this.m_sourceBuffer.buffered.start(0);
}

CSegmentLoader.prototype.GetBufferedEnd = function()
{
	var buffered = this.m_sourceBuffer.buffered;
	if ( buffered.length == 0 )
		return 0;

	return this.m_sourceBuffer.buffered.end(0);
}

CSegmentLoader.prototype.SeekToSegment = function( nSeekTime, bForceBufferClear )
{
	// if seeking outside of the main buffer or forced override
	if ( nSeekTime < this.GetBufferedStart() || nSeekTime > this.GetBufferedEnd() || bForceBufferClear )
	{
		this.m_bSeekInProgress = true;

		// Allow any current download to complete
		if ( this.m_xhr )
		{
			// use download timeout handler to block new downloads from starting
			var _loader = this;
			this.m_schNextDownload = setTimeout( function() { _loader.SeekToSegment( nSeekTime, bForceBufferClear ) }, CDASHPlayer.DOWNLOAD_RETRY_MS );
			return;
		}

		// stop download timeouts
		if ( this.m_schNextDownload )
		{
			clearTimeout( this.m_schNextDownload );
			this.m_schNextDownload = null;
		}

		if ( this.m_schRetryDownload )
		{
			clearTimeout( this.m_schRetryDownload );
			this.m_schRetryDownload = null;
		}

		if ( this.m_schWaitForBuffer )
		{
			clearTimeout( this.m_schWaitForBuffer );
			this.m_schWaitForBuffer = null;
		}

		// Set the next segment based on nSeekTime, -1 for start of the segment for the time.
		var nSegmentTime = CMPDParser.GetSegmentForTime( this.m_adaptation, nSeekTime * 1000 ) - 1;
		this.m_nNextSegment = Math.max( nSegmentTime, this.m_adaptation.segmentTemplate.startNumber );

		// PlayerLog("Set Next Segment: " + this.m_nNextSegment + " at approx. " + SecondsToTime(this.m_nNextSegment * CMPDParser.GetSegmentDuration(this.m_adaptation) / 1000) + " seconds.");

		// flag an unused buffer cleanup
		this.m_bRemoveBufferState = true;
		this.UpdateBuffer();

		this.DownloadNextSegment();

		return false; // can't shift time just yet
	}
	else
	{
		// if not downloading, update next scheduled download in case we did a seek to the end of the buffered data
		if ( ( !this.m_xhr && this.m_schNextDownload ) || this.m_schWaitForBuffer )
		{
			clearTimeout( this.m_schNextDownload );
			this.m_schNextDownload = null;

			clearTimeout( this.m_schWaitForBuffer );
			this.m_schWaitForBuffer = null;

			this.ScheduleNextDownload();
		}

		return true; // can shift time now
	}
}

CSegmentLoader.prototype.RemoveAllBuffers = function()
{
	if ( !this.m_bRemoveBufferState )
		return;

	// clears all buffer data from the player
	buffered = (this.m_sourceBuffer != null) ? this.m_sourceBuffer.buffered : {};
	var nMaxBuffered = 0;
	for ( var i = 0; i < buffered.length; i++ )
	{
		if ( nMaxBuffered < buffered.end( i ) )
			nMaxBuffered = buffered.end( i );
	}

	if ( nMaxBuffered != 0 )
	{
		this.m_nBufferUpdate = CSegmentLoader.s_BufferUpdateRemove;
		this.m_sourceBuffer.remove( 0, nMaxBuffered + 1 );
	}

	this.m_bRemoveBufferState = false;
}

CSegmentLoader.prototype.LogDownload = function ( xhr, startTime, dataSizeBytes )
{
	// remove the oldest log as needed
	if ( this.m_rgDownloadLog.length > this.m_nDownloadLogSize )
	{
		this.m_rgDownloadLog.shift();
	}

	// store the download
	var logEntry = [];
	logEntry.downloadTime = ( new Date().getTime() ) - startTime;

	if ( logEntry.downloadTime > 0 )
	{
		logEntry.dataSizeBytes = dataSizeBytes;
		this.m_rgDownloadLog.push( logEntry );

		// for stats tracking
		this.m_nBytesReceivedTotal += logEntry.dataSizeBytes;
		this.m_nSegmentDownloadTimeTotal += logEntry.downloadTime;
		this.m_nSegmentDownloadTimeEntries++;
		this.m_nSegmentDownloadTimeMinimum = ( this.m_nSegmentDownloadTimeMinimum == 0 ? logEntry.downloadTime : ( logEntry.downloadTime < this.m_nSegmentDownloadTimeMinimum ? logEntry.downloadTime : this.m_nSegmentDownloadTimeMinimum ) );
		this.m_nSegmentDownloadTimeMaximum = ( this.m_nSegmentDownloadTimeMaximum == 0 ? logEntry.downloadTime : ( logEntry.downloadTime > this.m_nSegmentDownloadTimeMaximum ? logEntry.downloadTime : this.m_nSegmentDownloadTimeMaximum ) );
	}
}

CSegmentLoader.prototype.GetBandwidthRate = function ()
{
	var nTotalTime = 0;
	var nTotalDataSizeBits = 0;
	for (var i = 0; i < this.m_rgDownloadLog.length; i++)
	{
		nTotalTime +=  this.m_rgDownloadLog[i].downloadTime;
		nTotalDataSizeBits +=  this.m_rgDownloadLog[i].dataSizeBytes;
	}

	// return in bits (per second) as representation bandwidth is as well
	if (nTotalTime != 0)
	{
		return ((nTotalDataSizeBits * 8) / (nTotalTime / 1000));
	}
	else
	{
		return 0;
	}
}

CSegmentLoader.prototype.GetSegmentDownloadTimeStats = function( bResetStats )
{
	var seg_stats = {};
	if ( this.m_nSegmentDownloadTimeEntries > 0 )
	{
		seg_stats = {
			'seg_avg': ( this.m_nSegmentDownloadTimeTotal / this.m_nSegmentDownloadTimeEntries ) / 1000,
			'seg_min': this.m_nSegmentDownloadTimeMinimum / 1000,
			'seg_max': this.m_nSegmentDownloadTimeMaximum / 1000,
		}
	}
	else
	{
		seg_stats = {
			'seg_avg': 0,
			'seg_min': 0,
			'seg_max': 0,
		}
	}

	if ( bResetStats )
	{
		this.m_nSegmentDownloadTimeTotal = 0;
		this.m_nSegmentDownloadTimeEntries = 0;
		this.m_nSegmentDownloadTimeMinimum = 0;
		this.m_nSegmentDownloadTimeMaximum = 0;
	}

	return seg_stats;
}

CSegmentLoader.prototype.GetBytesReceived = function()
{
	return this.m_nBytesReceivedTotal;
}

CSegmentLoader.prototype.GetFailedSegmentDownloads = function()
{
	return this.m_nFailedSegmentDownloads;
}

CSegmentLoader.prototype.GetDownloadLog = function()
{
	return this.m_rgDownloadLog;
}

/////////////////////////////////////////////////////////////////
// MPD parser
/////////////////////////////////////////////////////////////////
function CMPDParser()
{
	this.availabilityStartTime = new Date();
	this.periods = []
}

CMPDParser.strBaseURL = '';
CMPDParser.GetBaseURL = function()
{
	return CMPDParser.strBaseURL;
}

CMPDParser.strStatsLink = '';
CMPDParser.strStalledLink = '';
CMPDParser.GetAnalyticsStatsLink = function()
{
	return CMPDParser.strStatsLink;
}

CMPDParser.GetAnalyticsStalledLink = function()
{
	return CMPDParser.strStalledLink;
}

CMPDParser.prototype.BParse = function( xmlDoc )
{
	var _mpd = this;
	xml = $J( xmlDoc );
	_mpd.m_xml = xml;

	// get mpd
	var xmlMPD = xml.find( 'MPD' );
	if ( xmlMPD.size() == 0 )
	{
		// might be the root node, check
		xmlMPD = xml.filter(':first');
		if (xmlMPD[0].nodeName != 'MPD')
		{
			return false;
		}
	}

	xmlMPD = xmlMPD[0];
	_mpd.type = $J( xmlMPD ).attr( 'type' );
	_mpd.minBufferTime = _mpd.ParseDuration(xmlMPD, 'minBufferTime');
	if (_mpd.type == 'dynamic')
	{
		_mpd.availabilityStartTime = _mpd.ParseDate(xmlMPD, 'availabilityStartTime');
		_mpd.publishTime = _mpd.ParseDate(xmlMPD, 'publishTime');
		_mpd.minimumUpdatePeriod = _mpd.ParseDuration(xmlMPD, 'minimumUpdatePeriod');
		_mpd.timeShiftBufferDepth = _mpd.ParseDuration(xmlMPD, 'timeShiftBufferDepth');

		if (!_mpd.availabilityStartTime || !_mpd.publishTime || !_mpd.minimumUpdatePeriod || !_mpd.minBufferTime || !_mpd.timeShiftBufferDepth )
		{
			return false;
		}
	}
	else if (_mpd.type == 'static' )
	{
		_mpd.mediaPresentationDuration = _mpd.ParseDuration(xmlMPD, 'mediaPresentationDuration');

		if ( !_mpd.minBufferTime || !_mpd.mediaPresentationDuration ) {
			PlayerLog("MPD - Missing Buffer Time or Presentation Duration");
			return false;
		}
	}

	// MPD BaseURL if set - Must be direct child of MPD
	var baseUrl = $J( xmlMPD ).find('> BaseURL');
	if ( baseUrl )
	{
		CMPDParser.strBaseURL = baseUrl.text();
	}

	// stats reporting if Analytics set in MPD
	var analytics = $J( xmlMPD ).find( 'Analytics' );
	if ( analytics )
	{
		CMPDParser.strStatsLink = $J( analytics ).attr( 'statslink' );
		CMPDParser.strStalledLink = $J( analytics ).attr( 'stalledlink' );
	}

	// grab all periods.. only support 1
	var xmlPeriods = xml.find( 'Period' );
	if ( xmlPeriods.size() == 0 )
		return false;

	var xmlPeriod = xmlPeriods[0];
	var period = {};

	period.id = $J( xmlPeriod ).attr( 'id' );
	period.start = _mpd.ParseDuration( xmlPeriod, 'start' );
	if ( !period.id || period.start === null )
	{
		PlayerLog("MPD - Missing Period Information.")
		return false;
	}

	period.duration = _mpd.ParseDuration( xmlPeriod, 'duration' ); // optional on live

	// parse adaptation sets for this period
	var bError = false;
	_mpd.periods = [];
	_mpd.periods.push( period );
	_mpd.periods[0].adaptationSets = [];
	$J( xmlPeriod ).find( 'AdaptationSet' ).each( function()
	{

		var xmlAdaptation = $J( this );
		var adaptationSet = {};
		adaptationSet.segmentAlignment = _mpd.ParseBool( xmlAdaptation, 'segmentAlignment' );
		adaptationSet.isClosedCaption = ( xmlAdaptation.attr( 'mimeType' ) == "text/vtt" ? true : false );
		adaptationSet.language = xmlAdaptation.attr( 'lang' );
		adaptationSet.containsVideo = false;
		adaptationSet.containsAudio = false;

		if ( !adaptationSet.isClosedCaption )
		{
			if ( adaptationSet.segmentAlignment == null )
			{
				bError = true;
				PlayerLog("MPD - Segment Alignment Missing");
				return;
			}

			// parse components
			$J( xmlAdaptation ).find( 'ContentComponent' ).each( function()
			{
				var xmlComponent = $J( this );
				var type = $J( xmlComponent ).attr( 'contentType' );
				if ( type == 'video' )
					adaptationSet.containsVideo = true;
				if ( type == 'audio' )
					adaptationSet.containsAudio = true;
			});

			if ( adaptationSet.containsVideo )
			{
				var xmlThumbnails = $J( xmlAdaptation ).find('> Thumbnails');
				if ( xmlThumbnails.size() != 0 )
				{
					adaptationSet.thumbnails = {
						period: _mpd.ParseInt( xmlThumbnails, 'period' ),
						template: $J( xmlThumbnails ).attr( 'template' ),
						sheet: _mpd.ParseInt( xmlThumbnails, 'sheet' ),
						sheetSeconds: _mpd.ParseInt( xmlThumbnails, 'period' ) * _mpd.ParseInt( xmlThumbnails, 'sheet' )
					}
				}
			}

			// find segment template
			var xmlSegmentTemplates = $J( xmlAdaptation ).find( 'SegmentTemplate' );
			if ( xmlSegmentTemplates.size() == 0 )
			{
				bError = true;
				PlayerLog("MPD - Segment Template Missing");
				return;
			}

			var xmlSegmentTemplate = xmlSegmentTemplates[0];
			var segmentTemplate = {};
			segmentTemplate.timescale = _mpd.ParseInt( xmlSegmentTemplate, 'timescale' );
			segmentTemplate.duration = _mpd.ParseInt( xmlSegmentTemplate, 'duration' );
			segmentTemplate.startNumber = _mpd.ParseInt( xmlSegmentTemplate, 'startNumber' );
			segmentTemplate.media = $J( xmlSegmentTemplate ).attr( 'media' );
			segmentTemplate.initialization = $J( xmlSegmentTemplate ).attr( 'initialization' );
			if ( !segmentTemplate.timescale || !segmentTemplate.duration || !segmentTemplate.startNumber || !segmentTemplate.media || !segmentTemplate.initialization )
			{
				bError = true;
				PlayerLog("MPD - Segment Template Data Missing");
				return false;
			}

			adaptationSet.segmentTemplate = segmentTemplate;

			// parse all representations
			adaptationSet.representations = [];
			$J( xmlAdaptation ).find( 'Representation' ).each( function()
			{
				var xmlRepresentation = $J( this );
				var representation = {};
				representation.id = $J( xmlRepresentation ).attr( 'id' );
				representation.mimeType = $J( xmlRepresentation ).attr( 'mimeType' );
				representation.codecs = $J( xmlRepresentation ).attr( 'codecs' );
				representation.bandwidth = _mpd.ParseInt( xmlRepresentation, 'bandwidth' );

				if (adaptationSet.containsVideo)
				{
					representation.width = _mpd.ParseInt( xmlRepresentation, 'width');
					representation.height = _mpd.ParseInt( xmlRepresentation, 'height');
					representation.frameRate = $J( xmlRepresentation ).attr( 'frameRate' );
					if ( !representation.id || !representation.mimeType || !representation.codecs || !representation.bandwidth  )
					{
						bError = true;
						PlayerLog("MPD - Representation Video Data Missing");
						return;
					}
				}
				else if (adaptationSet.containsAudio)
				{
					representation.audioSamplingRate = _mpd.ParseInt( xmlRepresentation, 'audioSamplingRate');

					// AudioChannelConfiguration to determine Audio Channels
					var xmlAudioChannelConfig = $J( xmlRepresentation ).find("AudioChannelConfiguration");
					if (xmlAudioChannelConfig)
						representation.audioChannels = _mpd.ParseInt( xmlAudioChannelConfig, 'value');

					if (!representation.audioChannels)
						representation.audioChannels = 2;

					if ( !representation.id || !representation.mimeType || !representation.codecs || !representation.bandwidth || !representation.audioSamplingRate || !representation.audioChannels)
					{
						bError = true;
						PlayerLog("MPD - Representation Audio Data Missing");
						return;
					}
			}

				adaptationSet.representations.push( representation );
			});
		}
		else
		{
			// parse each adaptation set for closed captions
			adaptationSet.representations = [];
			$J( xmlAdaptation ).find( 'Representation' ).each( function()
			{
				var xmlRepresentation = $J( this );
				var representation = {};
				representation.id = $J( xmlRepresentation ).attr( 'id' );
				representation.bandwidth = _mpd.ParseInt( xmlRepresentation, 'bandwidth' );

				var closedCaptionFile = $J( xmlAdaptation ).find( 'BaseURL' );
				if ( !closedCaptionFile )
				{
					bError = true;
					PlayerLog( "Closed Caption File has no BaseURL for (id): " + representation.id );
					return;
				}

				// parse and store the caption URL
				representation.closedCaptionFile = CMPDParser.strBaseURL + CMPDParser.ReplaceTemplateTokens( closedCaptionFile.first().text(), representation.id, 0 );

				adaptationSet.representations.push( representation );
			});
		}

		// done
		_mpd.periods[0].adaptationSets.push( adaptationSet );
	});

	return !bError;
}

CMPDParser.prototype.BUpdate = function( xmlDoc )
{
	var _mpd = this;
	xml = $J( xmlDoc );
	_mpd.m_xml = xml;

	// make sure it is an mpd
	var xmlMPD = xml.find( 'MPD' );
	if ( xmlMPD.size() == 0 )
		return false;

	// stats reporting if Analytics set in MPD
	var analytics = $J( xmlMPD ).find( 'Analytics' );
	if ( analytics )
	{
		CMPDParser.strStatsLink = $J( analytics ).attr( 'statslink' );
		CMPDParser.strStalledLink = $J( analytics ).attr( 'stalledlink' );
	}

	// find existing period
	if ( this.periods.length == 0 )
		return false;

	var xmlPeriod;
	xml.find( 'Period' ).each( function()
	{
		var newID = $J( this ).attr( 'id' );
		var oldID = _mpd.periods[0].id;
		if ( newID == _mpd.periods[0].id )
			xmlPeriod = $J( this );
	});

	if ( !xmlPeriod )
		return false;

	// parse adapation sets for this period
	var bError = false;
	$J( xmlPeriod ).find( 'AdaptationSet' ).each( function()
	{
		var xmlAdaptation = $J( this );
		var strAdaptationID = xmlAdaptation.attr( 'id ' );
		if ( !strAdaptationID )
			return;

		// find matching adaptation
		var adaptationSet = null;
		for ( var i = 0; i < _mpd.periods[0].adaptationSets; i++ )
		{
			if ( strAdaptationID == _mpd.periods[0].adaptationSets[i] )
			{
				adaptationSet = _mpd.periods[0].adaptationSets[i];
				break;
			}
		}

		if ( !adaptationSet )
			return;

		if ( adaptationSet.containsVideo )
		{
			var xmlThumbnails = $J( xmlAdaptation ).find('> Thumbnails');
			if ( xmlThumbnails )
			{
				adaptationSet.thumbnails = {
					period: _mpd.ParseInt( xmlThumbnails, 'period' ),
					template: $J( xmlThumbnails ).attr( 'template' ),
					sheet: _mpd.ParseInt( xmlThumbnails, 'sheet' ),
					sheetSeconds: _mpd.ParseInt( xmlThumbnails, 'period' ) * _mpd.ParseInt( xmlThumbnails, 'sheet' )
				}
			}
		}

		var strMedia = $J( xmlSegmentTemplate ).attr( 'media' );
		var strInitialization = $J( xmlSegmentTemplate ).attr( 'initialization' );
		if ( !strMedia || !strInitialization )
		{
			bError = true;
			return;
		}

		var segmentTemplate = adaptationSet.segmentTemplate;
		segmentTemplate.media = strMedia;
		segmentTemplate.initialization = strInitialization;
	});

	return !bError;
}

CMPDParser.prototype.ParseDate = function( xml, strAttr )
{
	var val = $J( xml ).attr( strAttr );
	if ( !val )
		return null;

	var date = new Date( val );
	if ( Object.prototype.toString.call( date ) === '[object Date]' )
		return date;

	return null;
}

CMPDParser.prototype.ParseDuration = function( xml, strAttr )
{
	// example: PT3H50M22.33S or PT120S
	var val = $J( xml ).attr( strAttr );
	if ( !val )
		return null;

	var ret = 0;
	match = val.match( /(\d*)H/ );
	if ( match )
		ret += parseFloat(match[1]) * 60 * 60;

	match = val.match( /(\d*)M/ );
	if ( match )
		ret += parseFloat(match[1]) * 60;

	match = val.match( /(\d*\.?\d*)S/ );
	if ( match )
		ret += parseFloat(match[1]);

	return ret;
}

CMPDParser.prototype.ParseBool = function( xml, strAttr )
{
	var val = $J( xml ).attr( strAttr );
	if ( !val )
		return null;

	val = val.toLowerCase();
	if ( val == 'true' )
		return true;
	if ( val == 'false' )
		return false;

	return null;
}

CMPDParser.prototype.ParseInt = function( xml, strAttr )
{
	var val = $J( xml ).attr( strAttr );
	if ( !val )
		return null;

	return parseInt( val );
}

CMPDParser.ReplaceTemplateTokens = function( template, representationID, number )
{
	template = template.replace( '$RepresentationID$', representationID );
	template = template.replace( '$Number$', number );

	return template;
}

CMPDParser.GetInitSegmentURL = function( adaptationSet, representation )
{
	var url = CMPDParser.GetBaseURL() + adaptationSet.segmentTemplate.initialization;
	return CMPDParser.ReplaceTemplateTokens( url, representation.id, 0 );
}

CMPDParser.GetSegmentURL = function( adaptationSet, representation, nSegment )
{
	var url = CMPDParser.GetBaseURL() + adaptationSet.segmentTemplate.media;
	return CMPDParser.ReplaceTemplateTokens( url, representation.id, nSegment );
}

CMPDParser.GetSegmentAvailableFromNow = function( adaptationSet, nSegment, rtMovieStart )
{
	var unSegmentDurationMS = CMPDParser.GetSegmentDuration( adaptationSet );
	var iSegment = nSegment - adaptationSet.segmentTemplate.startNumber;

	var unAvailableMS = Date.now() - rtMovieStart;
	var unSegmentReadyAt = iSegment * unSegmentDurationMS;

	return unSegmentReadyAt - unAvailableMS;
}

CMPDParser.GetSegmentDuration = function( adaptationSet )
{
	// currently only support all segments having the same duration
	return (adaptationSet.segmentTemplate.duration / adaptationSet.segmentTemplate.timescale) * 1000;
}

CMPDParser.GetSegmentForTime = function( adaptationSet, unTime )
{
	// currently only support all segments having the same duration
	var unSegmentDuration = CMPDParser.GetSegmentDuration( adaptationSet );
	return Math.floor( unTime / unSegmentDuration ) + 1;
}

CMPDParser.prototype.GetPeriodDuration = function( unPeriod )
{
	if ( this.type == 'dynamic' )
	{
		PlayerLog( 'GetPeriodDuration is unknown for live content!' );
		return 0;
	}

	if ( unPeriod < this.periods.length && this.periods[unPeriod].duration )
		return this.periods[unPeriod].duration;
	else
		return 0;
}

/////////////////////////////////////////////////////////////////
// UI
/////////////////////////////////////////////////////////////////
function CDASHPlayerUI( player )
{
	this.m_bHidden = false;
	this.m_player = player;
	this.m_elOverlay = null;
	this.m_elLiveBanner = null;
	this.m_elVideoWrapper = null;
	this.m_elContainer = null;
	this.m_timeoutHide = null;
	this.m_bPlayingLiveEdge = true;
	this.m_elVideoTitle = null;
	this.m_elBufferingMessage = null;
	this.m_elBigPlayPauseIndicator = null;
	this.m_bIsSafariBrowser = (navigator.userAgent.toLowerCase().indexOf('safari') != -1 && navigator.userAgent.toLowerCase().indexOf('chrome') == -1);
	this.m_bIsInternetExplorer = (navigator.appVersion.toLowerCase().indexOf('trident/') != -1);
	this.m_strUniqueSettingsID = '';
	this.m_elActiveNotification = null;
	this.m_schNotificationTimeout = null;
	this.m_ThumbnailInfo = null;
}

CDASHPlayerUI.s_ClosedCaptionsNone = "none";
CDASHPlayerUI.PRELOAD_THUMBNAILS = false;

CDASHPlayerUI.s_overlaySrc =	'<div class="dash_overlay no_select">' +
										'<div class="play_button play"></div>' +
										'<div class="control_container">' +
											'<div class="fullscreen_button"></div>' +
											'<div class="time"></div>' +
											'<div class="live_button"></div>' +
											'<div class="player_settings"></div>' +
											'<div class="volume_icon"></div>' +
											'<div class="volume_slider">' +
												'<div class="volume_handle"></div>' +
											'</div>' +
										'</div>' +
										'<div class="progress_bar_wrapper">' +
											'<div class="progress_bar_container">' +
												'<div class="progress_bar_background"></div>' +
												'<div class="progress_bar">' +
													'<div class="progress_time_info no_select">' +
														'<span class="time_display"></span>' +
													'</div>' +
													'<div class="progress_time_bar"></div>'
												'</div>' +
											'</div>' +
										'</div>' +
									'</div>';

CDASHPlayerUI.prototype.Init = function()
{
	var _ui = this;
	var _overlay = this.parentNode;

	this.m_elContainer = $J( this.m_player.m_elVideoPlayer.parentNode );

	this.m_elOverlay = $J( CDASHPlayerUI.s_overlaySrc );
	this.m_elContainer.css( {'position': 'relative', 'overflow': 'hidden' } );
	this.m_elContainer.append( this.m_elOverlay );

	this.m_elContainer.on( 'fullscreenchange', function() { _ui.OnFullScreenChange(); } );
	this.m_elContainer.on( 'mozfullscreenchange', function() { _ui.OnFullScreenChange(); } );
	this.m_elContainer.on( 'webkitfullscreenchange', function() { _ui.OnFullScreenChange(); } );
	this.m_elContainer.on( 'msfullscreenchange', function() { _ui.OnFullScreenChange(); } );

	var elVideoPlayer = $J( this.m_player.m_elVideoPlayer );
	elVideoPlayer.on( 'mousemove', function() { _ui.OnMouseMovePlayer() } );
	elVideoPlayer.on( 'timeupdate', function() { _ui.OnTimeUpdatePlayer() } );
	elVideoPlayer.on( 'bufferedupdate', function() { _ui.OnTimeUpdatePlayer() } );
	elVideoPlayer.on( 'playing', function() { _ui.OnPlaying() } );
	elVideoPlayer.on( 'click', function() { _ui.TogglePlayPause() } );
	elVideoPlayer.on( 'pause', function() { _ui.OnPause() } );
	elVideoPlayer.on( 'initialized', function() { _ui.OnVideoInitialized(); } );

	$J( window ).on( 'keypress', function(e) { _ui.OnKeyPress( e ); } );

	this.m_elOverlay.on( 'mouseenter', function() { _ui.OnMouseEnterOverlay() } );
	this.m_elOverlay.on( 'mouseleave', function( e ) { _ui.OnMouseLeaveOverlay( e ) } );

	$J( '.live_button', _overlay ).on('click', function() { _ui.JumpToLive(); } );
	$J( '.play_button', _overlay ).on('click', function() { _ui.TogglePlayPause(); } );
	$J( '.volume_slider', _overlay ).on( 'click', function(e) { _ui.OnVolumeClick( e, this ); } );
	$J( '.volume_slider', _overlay ).on( 'mousedown', function(e) { _ui.OnVolumeStartDrag( e, this ); } );
	$J( '.volume_slider', _overlay ).on( 'mouseup', function(e) { _ui.OnVolumeStopDrag( e, this ); } );
	$J( '.volume_slider', _overlay ).on( 'mouseleave', function(e) { _ui.OnVolumeStopDrag( e, this ); } );

	$J( '.volume_icon', _overlay ).on( 'click', function(e) { _ui.ToggleMute( e, this ); });
	$J( '.fullscreen_button', _overlay ).on( 'click', function(e) { _ui.ToggleFullscreen(); });
	$J( '.progress_bar_container', _overlay ).on( 'click', function(e) { _ui.OnProgressClick( e, this ); });
	$J( '.progress_bar_container', _overlay ).on( 'mousemove', function(e) { _ui.OnProgressHover( e, this ); });
	$J( '.progress_bar_container', _overlay ).on( 'mouseleave', function(e) { _ui.OnProgressLeave( e, this ); });

	this.LoadVolumeSettings();
}

CDASHPlayerUI.prototype.OnVideoInitialized = function()
{
	var _ui = this;
	if ( this.m_player.BIsLiveContent() )
	{
		if ( !this.m_elLiveBanner )
		{
			this.m_elLiveBanner = $J( '<div class="dash_video_live_banner"></div>' );
			this.m_elLiveBanner.on( 'click', function() { _ui.JumpToLive(); } );
			this.m_elContainer.append( this.m_elLiveBanner );
		}
	}
	else if ( this.m_elLiveBanner )
	{
		this.m_elLiveBanner.remove();
		this.m_elLiveBanner = null;
	}

	if ( !this.m_player.BIsLiveContent() )
	{
		if ( !this.m_elBufferingMessage )
		{
			this.m_elBufferingMessage = $J( '<div id="dash_video_buffering_message"></div>' );
			this.m_elContainer.append( this.m_elBufferingMessage );
		}
	}

	if ( !this.m_elVideoTitle )
	{
		this.m_elVideoTitle = $J( '<div id="dash_video_title_banner" class="no_select"></div>' );
		this.m_elContainer.append( this.m_elVideoTitle );
	}

	if ( !this.m_elBigPlayPauseIndicator )
	{
		this.m_elBigPlayPauseIndicator = $J( '<div class="dash_big_playpause_indicator">' +
			'<div class="dash_big_playpause_indicator_state"></div>' +
			'</div>' );
		this.m_elContainer.append( this.m_elBigPlayPauseIndicator );
		this.m_elBigPlayPauseIndicator.on( 'click', function() { _ui.TogglePlayPause() } );
	}

	if ( !this.m_player.BPlayingAudio() )
	{
		$J( '.control_container', this.m_elOverlay ).addClass( 'no_audio_track' );
		$J( this.m_player.m_elVideoPlayer ).one( 'bufferingcomplete', function() { _ui.DisplayNotification( 'This video does not contain any audio', 15000 ) } );
	}
	else
	{
		$J( '.control_container', this.m_elOverlay ).removeClass( 'no_audio_track' );
	}

	this.m_ThumbnailInfo = this.m_player.GetThumbnailInfoForVideo();
	if ( this.m_ThumbnailInfo && this.m_ThumbnailInfo.template )
	{
		// update display
		$J( '.progress_time_info' ).addClass( 'thumbnails' );

		// precache images for VOD
		if ( !this.m_player.BIsLiveContent() && CDASHPlayerUI.PRELOAD_THUMBNAILS )
		{
			var rgData = _ui.GetTimelineData();
			var nThumbnailSheets = Math.ceil( ( rgData.nTimeEnd - _ui.m_ThumbnailInfo.period ) / _ui.m_ThumbnailInfo.sheetSeconds );
			$J( '<div/>', { id: 'thumbnailcache' } ).appendTo( 'body' );
			for ( var i = 0; i < nThumbnailSheets; i++ )
			{
				var image_url = this.m_ThumbnailInfo.template.replace( '$Seconds$', i * _ui.m_ThumbnailInfo.sheetSeconds );
				$J('<img />').attr( 'src', image_url ).appendTo( '#thumbnailcache' ).hide();
			}
		}
	}

	this.InitSettingsPanelInUI();
}

CDASHPlayerUI.prototype.InitSettingsPanelInUI = function()
{
	// Init Panel - only once
	if ( $J( '.player_settings .settings_icon').length != 0 )
		return;

	$J( '.player_settings').append(
		    '<div class="settings_icon"><div class="video_quality_label"></div></div>' +
			'<div class="settings_panel">' +
				'<div class="representation_video"></div>' +
				'<div class="representation_audio"></div>' +
				'<div class="representation_playbackRate"></div>' +
				'<div class="representation_captions"></div>' +
			'</div>');

	$J( '.settings_icon').on('click', function()
	{
		if ( $J('.dash_closed_captions_customization').length != 0 )
		{
			$J( '.cc_cancel' ).click();
		}

		$J('.settings_panel').toggle();
	} );

   	var _ui = this;

	// Video Representations
	rgRepresentation = this.m_player.GetRepresentationsArray( true );

	$J('.representation_video').show();
	$J('.representation_video').append('<div class="settings_label">Quality:</div><select id="representation_select_video" class="representation_select"></select>');
	$J('#representation_select_video').append('<option value="-1">Auto</option>');

	for (var r = 0; r < rgRepresentation.length; r++)
	{
		if ( rgRepresentation[r].height.toString().length > 1 )
		{
			var strResolution = rgRepresentation[r].height + 'p';
			$J('#representation_select_video').append('<option value="' + r + '">' + strResolution + ' (' + ( rgRepresentation[r].bandwidth / 1000000 ).toFixed(1) + 'Mbps)</option>');
		}
	}

	$J( '#representation_select_video option[value="-1"]').attr('selected', 'selected');

	$J( '#representation_select_video').on('change', function()
	{
		_ui.m_player.UpdateRepresentation(this.value, true);
		this.blur();
	} );

	// Audio Representations
	rgRepresentation = this.m_player.GetRepresentationsArray( false );

	// show selector if only more than one audio representation
	if (rgRepresentation.length > 1)
	{
		$J('.representation_audio').show();
		$J('.representation_audio').append('<div class="settings_label">Audio:</div><select id="representation_select_audio" class="representation_select"></select>');

		for (var r = 0; r < rgRepresentation.length; r++)
		{
			var strChannelInfo = rgRepresentation[r].audioChannels + "-Channel";
			$J('#representation_select_audio').append('<option value="' + ( r ) + '">' + strChannelInfo + ' (' + Math.ceil( rgRepresentation[r].bandwidth / 1000 ) + 'Kbps)</option>');
		}

		$J( '#representation_select_audio').on('change', function()
		{
			_ui.m_player.UpdateRepresentation(this.value, false);
			this.blur();
		} );
	}

	// Video Playback Rate
	if ( !this.m_player.BIsLiveContent() )
	{
		rgRepresentation = [50,90,100,110,120,150,200];

		$J('.representation_playbackRate').show();
		$J('.representation_playbackRate').append('<div class="settings_label">Speed:</div><select id="representation_select_playbackRate" class="representation_select"></select>');

		for (var r = 0; r < rgRepresentation.length; r++)
		{
			$J('#representation_select_playbackRate').append('<option value="' + rgRepresentation[r]/100 + '">' + rgRepresentation[r] + '%</option>');
		}

		$J( '#representation_select_playbackRate option[value="1"]').attr('selected', 'selected');

		$J( '#representation_select_playbackRate').on('change', function()
		{
			_ui.m_player.SetPlaybackRate(this.value);
			this.blur();
		} );
	}

	// Closed Captions
	rgRepresentation = this.m_player.GetClosedCaptionsArray();

	// show selector if there is a closed caption available
	if (rgRepresentation.length > 0)
	{
		$J( '.representation_captions').show();
		$J( '.representation_captions').append('<div class="settings_label">Captions:</div><select id="representation_select_captions" class="representation_select"></select>');
		$J( '#representation_select_captions').append('<option value="' + CDASHPlayerUI.s_ClosedCaptionsNone + '">None</option>');

		for (var r = 0; r < rgRepresentation.length; r++)
		{
			if ( rgRepresentation[r].code.toUpperCase() != CDASHPlayerUI.s_ClosedCaptionsNone.toUpperCase() )
			{
				$J('#representation_select_captions').append('<option value="' + rgRepresentation[r].code + '">' + rgRepresentation[r].display + "</option>");
			}
		}

		$J( '#representation_select_captions').on('change', function()
		{
			WebStorage.SetLocal( "closed_caption_language_setting_" + _ui.m_strUniqueSettingsID, this.value );
			_ui.m_player.UpdateClosedCaption( this.value );
			this.blur();
		} );

		// customize captions link and action
		$J( '.representation_captions' ).append('<div class="customize_captions_wrap"><span class="customize_captions"></span></div>');
		$J( '.customize_captions' ).text("Caption Options");
		$J( '.customize_captions').on('click', function()
		{
			_ui.ShowClosedCaptionOptions();
			$J('.settings_panel').toggle();
		} );

		_ui.InitClosedCaptionOptionDialog();
	}
}

CDASHPlayerUI.prototype.SetUniqueSettingsID = function( uniqueSettingsID )
{
	this.m_strUniqueSettingsID = uniqueSettingsID.toString();
}

CDASHPlayerUI.SetClosedCaptionLanguageInUI = function( strCode )
{
	var uiCaptionLanguage = $J("#representation_select_captions");

	if ( uiCaptionLanguage.length )
		$J( '#representation_select_captions option[value="' + strCode + '"]').attr('selected', 'selected');
}

CDASHPlayerUI.GetSavedClosedCaptionLanguage = function( strUniqueSettingsID )
{
	return WebStorage.GetLocal( "closed_caption_language_setting_" + strUniqueSettingsID.toString() );
}

CDASHPlayerUI.prototype.SetPlayerPlaybackRate = function()
{
	this.m_player.SetPlaybackRate( $J( '#representation_select_playbackRate' ).val() );
}

CDASHPlayerUI.prototype.Show = function()
{
	this.m_bHidden = false;
	clearTimeout( this.m_timeoutHide );
	$J( this.m_elContainer ).addClass( 'dash_show_player_ui' );

	this.OnTimeUpdatePlayer();
}

CDASHPlayerUI.prototype.Hide = function()
{
	var _ui = this;
	clearTimeout( this.m_timeoutHide );

	if ( !this.m_player.m_elVideoPlayer.paused )
	{
		this.m_timeoutHide = setTimeout( function()
		{
			_ui.m_bHidden = true;
			$J( _ui.m_elContainer ).removeClass( 'dash_show_player_ui' );
			$J( '.volume_slider', _ui.m_elOverlay ).off( 'mousemove' );
			$J( '.settings_panel' ).hide();
			_ui.OnProgressLeave();
		}, 3000 );
	}
}

CDASHPlayerUI.prototype.OnMouseMovePlayer = function()
{
	this.Show();
	this.Hide();
}

CDASHPlayerUI.prototype.GetTimelineData = function()
{
	var elVideoPlayer = this.m_player.m_elVideoPlayer;
	var nBufferedStart = null;
	var nBufferedEnd = 0;
	for ( var i = 0; i < elVideoPlayer.buffered.length; i++ )
	{
		if ( nBufferedStart == null || elVideoPlayer.buffered.start( i ) < nBufferedStart )
			nBufferedStart = elVideoPlayer.buffered.start( i );

		if ( elVideoPlayer.buffered.end( i ) > nBufferedEnd )
			nBufferedEnd = elVideoPlayer.buffered.end( i );
	}

	if ( nBufferedStart == null )
		nBufferedStart = 0;

	var nTimeStart = 0;
	var nTimeEnd = elVideoPlayer.duration;
	if ( this.m_player.BIsLiveContent() )
	{
		nTimeStart = nBufferedStart;
		nTimeEnd = Math.max( nBufferedEnd, this.m_player.GetLiveBufferWindow() + nBufferedStart );
	}
	else
	{
		nTimeEnd = this.m_player.m_mpd.GetPeriodDuration(0);
	}

	var rgRet = {};
	rgRet.nBufferedStart = nBufferedStart;
	rgRet.nBufferedEnd = nBufferedEnd;
	rgRet.nTimeStart = nTimeStart;
	rgRet.nTimeEnd = nTimeEnd;

	return rgRet;
}

CDASHPlayerUI.prototype.OnTimeUpdatePlayer = function()
{
	// buffering should show/hide no matter if the UI is on screen
	this.UpdateBufferingProgress();

	if ( this.m_bHidden )
		return;

	var elVideoPlayer = this.m_player.m_elVideoPlayer;
	var rgData = this.GetTimelineData();

	var nProgressPct = (( elVideoPlayer.currentTime - rgData.nTimeStart ) / (rgData.nTimeEnd - rgData.nTimeStart)) * 100;
	var nLoadedPct = (( rgData.nBufferedEnd - rgData.nTimeStart ) / (rgData.nTimeEnd - rgData.nTimeStart)) * 100;

	//PlayerLog( 'bstart: ' + nBufferedStart + ', bend: ' + nBufferedEnd + ', tstart: ' + nTimeStart + ', tend: ' + nTimeEnd + ', progpct: ' + nProgressPct + ', loadpct: ' + nLoadedPct );

	if ( this.m_player.BIsLiveContent() )
	{
		$J( '.live_button' ).show();

		if ( this.m_bPlayingLiveEdge )
		{
			$J( this.m_elContainer ).addClass( 'dash_live_edge' );
			nProgressPct = nLoadedPct;
		}
		else
		{
			$J( this.m_elContainer ).removeClass( 'dash_live_edge' );
		}
	}
	else
	{
		$J( '.live_button' ).hide();
	}

	//PlayerLog( 'bstart: ' + nBufferedStart + ', bend: ' + nBufferedEnd + ', tstart: ' + nTimeStart + ', tend: ' + nTimeEnd + ', progpct: ' + nProgressPct + ', loadpct: ' + nLoadedPct );

	$J( '.progress_bar', this.m_elOverlay ).stop().css( {'width': nProgressPct + '%'}, 200 );
	$J( '.progress_bar_background', this.m_elOverlay ).stop().css({'width': nLoadedPct + '%'}, 200);

	var timeString = SecondsToTime( elVideoPlayer.currentTime ) + " / " + SecondsToTime( rgData.nTimeEnd - rgData.nTimeStart );
	if ( this.m_player.BIsLiveContent() )
		timeString = SecondsToTime( elVideoPlayer.currentTime );

	$J( '.time', this.m_elOverlay ).text( timeString );

	// show adaptive value when selected
	var repVideo = $J( '#representation_select_video' );
	if ( repVideo.length != 0 && !repVideo.is( ':focus' ) )
	{
		if ( repVideo.val() == -1 && this.m_player.m_nPlaybackHeight > 0)
		{
			$J( '#representation_select_video option:first' ).text("Auto (" + this.m_player.m_nPlaybackHeight + "p)");
		}
		else
		{
			$J( '#representation_select_video option:first' ).text("Auto");
		}
	}

	var repQualityLabel = $J('.video_quality_label');
	if ( repQualityLabel.length != 0 )
	{
		if ( this.m_player.m_nPlaybackHeight != 0 )
			repQualityLabel.text(this.m_player.m_nPlaybackHeight + "p");
	}
}

CDASHPlayerUI.prototype.UpdateBufferingProgress = function()
{
	var buffMsg = $J( '#dash_video_buffering_message');
	if ( this.m_player.BIsBuffering() && this.m_player.m_elVideoPlayer.readyState != CDASHPlayer.HAVE_NOTHING )
	{
		if ( this.m_player.GetPercentBuffered() != 100 )
			buffMsg.text("Loading... " + this.m_player.GetPercentBuffered() + "%").show();
	}
	else
	{
		if (buffMsg.text() != "")
		{
			if ( buffMsg.queue() == 0 )
			{
				buffMsg.text("Loading... 100%");
				buffMsg.fadeOut(500, function()
				{
					buffMsg.text("");
				});
			}
		}
	}
}

CDASHPlayerUI.prototype.SetVideoTitle = function( strTitle )
{
	if ( $J('#dash_video_title_banner') )
		$J( '#dash_video_title_banner' ).text( strTitle );
}

CDASHPlayerUI.prototype.JumpToLive = function()
{
	if ( this.m_bPlayingLiveEdge )
		return;

	this.m_player.SeekToBufferedEnd();
	this.m_bPlayingLiveEdge = true;

	if ( this.m_player.m_elVideoPlayer.paused )
		this.TogglePlayPause();

	this.OnTimeUpdatePlayer();
}

CDASHPlayerUI.prototype.OnPlaying = function()
{
	$J( '.play_button', this.m_elOverlay ).removeClass( 'play' );
	$J( '.play_button', this.m_elOverlay ).addClass( 'pause' );

	this.Hide();
}

CDASHPlayerUI.prototype.OnPause = function()
{
	this.Show();
	this.m_bPlayingLiveEdge = false;
	this.OnTimeUpdatePlayer();
}

CDASHPlayerUI.prototype.TogglePlayPause = function()
{
	if ( !$J('.settings_panel').is(':hidden'))
	{
		$J('.settings_panel').hide();
		return;
	}

	var elVideoPlayer = this.m_player.m_elVideoPlayer;
	if( elVideoPlayer.paused )
	{
		elVideoPlayer.play();
		elVideoPlayer.playbackRate = this.m_player.m_nSavedPlaybackRate;
		$J( '.play_button', this.m_elOverlay ).addClass( 'pause' );
		$J( '.play_button', this.m_elOverlay ).removeClass( 'play' );
		this.ShowBigPlayPauseIndicator( true );
	}
	else
	{
		elVideoPlayer.pause();
		$J( '.play_button', this.m_elOverlay ).addClass( 'play' );
		$J( '.play_button', this.m_elOverlay ).removeClass( 'pause' );
		this.ShowBigPlayPauseIndicator( false )
	}
}

CDASHPlayerUI.prototype.ShowBigPlayPauseIndicator = function( playing )
{
	var indicator = $J( '.dash_big_playpause_indicator' );
	var state = $J( '.dash_big_playpause_indicator_state' );

		indicator.one( 'animationend webkitAnimationEnd oAnimationEnd MSAnimationEnd', function() { $J(this).removeClass( 'show' ); } );
	indicator.removeClass('show');
	FlushStyleChanges( indicator );

	if ( playing )
	{
		state.addClass('play_triangle');
		state.removeClass('pause_bars');
	}
	else
	{
		state.addClass('pause_bars');
		state.removeClass('play_triangle');
	}

	indicator.addClass('show');
}

CDASHPlayerUI.prototype.OnKeyPress = function( e )
{
		if ( e.keyCode == 32 && e.target == document.body )
	{
		e.preventDefault();
		this.TogglePlayPause();
		return false;
	}
}

CDASHPlayerUI.prototype.OnMouseEnterOverlay = function()
{
	clearTimeout( this.m_timeoutHide );
}

CDASHPlayerUI.prototype.OnMouseLeaveOverlay = function( e )
{
	var relTarget = e.relatedTarget ? e.relatedTarget : e.toElement;
	if ( this.m_player.m_elVideoPlayer == relTarget )
		return;

	this.Hide();
}

CDASHPlayerUI.prototype.OnVolumeClick = function( e, ele )
{
	var parentOffset = $J( ele ).offset();
	var relX = e.pageX - parentOffset.left;
	var volume =  relX / 80 ;

	this.SetVolume( volume );

	if( this.m_player.m_elVideoPlayer.muted )
		this.ToggleMute();
}

CDASHPlayerUI.prototype.SetVolume = function( value )
{
	value = Math.min( Math.max( value, 0 ), 1 );
	this.m_player.m_elVideoPlayer.volume = value;
	var sliderX = value * 80 - 2;
	$J( '.volume_handle', this.m_elOverlay ).css( {'left': sliderX + "px"} );

	WebStorage.SetLocal( 'video_volume', value );
}

CDASHPlayerUI.prototype.OnVolumeStartDrag = function( e, ele )
{
	var _ui = this;
	$J( '.volume_slider', this.m_elOverlay ).on( 'mousemove', function(e) { _ui.OnVolumeClick( e, this ); } );
	e.originalEvent.preventDefault();
}

CDASHPlayerUI.prototype.OnVolumeStopDrag = function( e, ele )
{
	$J( '.volume_slider', this.m_elOverlay ).off( 'mousemove' );
}

CDASHPlayerUI.prototype.ToggleMute = function( e, ele )
{
	if ( !this.m_player.BPlayingAudio() )
		return;

	var elVideoPlayer = this.m_player.m_elVideoPlayer;
	elVideoPlayer.muted = !elVideoPlayer.muted;

	WebStorage.SetLocal( 'video_mute', elVideoPlayer.muted );

	if( elVideoPlayer.muted )
	{
		$J( '.volume_icon',this.m_elOverlay ).addClass( 'muted' );
		$J( '.volume_handle', this.m_elOverlay ).css({ 'left': "0px" });
	}
	else
	{
		$J( '.volume_icon',this.m_elOverlay ).removeClass( 'muted' );
		this.SetVolume( elVideoPlayer.volume );
	}
}

CDASHPlayerUI.prototype.ToggleFullscreen = function()
{
	var elContainer = this.m_elOverlay[0].parentNode;
	var bFullscreen = document.fullscreen || document.webkitIsFullScreen || document.mozFullScreen || document.msFullscreenElement;

	if( !bFullscreen )
	{
		if( elContainer.requestFullscreen )
			elContainer.requestFullscreen();
		else if( elContainer.webkitRequestFullScreen && this.m_bIsSafariBrowser )
			elContainer.webkitRequestFullScreen();
		else if( elContainer.webkitRequestFullScreen )
			elContainer.webkitRequestFullScreen( Element.ALLOW_KEYBOARD_INPUT );
		else if( elContainer.mozRequestFullScreen )
			elContainer.mozRequestFullScreen();
		else if( elContainer.msRequestFullscreen )
			elContainer.msRequestFullscreen();

		$J( elContainer ).addClass( 'fullscreen' );
	}
	else
	{
		if( document.cancelFullscreen )
			document.cancelFullscreen();
		else if( document.webkitCancelFullScreen )
			document.webkitCancelFullScreen();
		else if( document.mozCancelFullScreen )
			document.mozCancelFullScreen();
		else if( document.msExitFullscreen )
			document.msExitFullscreen();

		$J( elContainer ).removeClass( 'fullscreen' );
	}
}

CDASHPlayerUI.prototype.OnFullScreenChange = function()
{
	var _ui = this;
	var bFullscreen = document.fullscreen || document.webkitIsFullScreen || document.mozFullScreen || document.msFullscreenElement;
	if ( bFullscreen )
	{
		$J( document ).on( 'keydown', function( e )
		{
			var bFullscreen = document.fullscreen || document.webkitIsFullScreen || document.mozFullScreen || document.msFullscreenElement;
			if ( e.keyCode == 27 && bFullscreen )
				_ui.ToggleFullscreen();
		});
	}
	else
	{
		$J( document ).off( 'keydown' );
		$J( this.m_elContainer ).removeClass( 'fullscreen' );
	}
}

CDASHPlayerUI.prototype.OnProgressClick = function( e, ele )
{
	var elVideoPlayer = this.m_player.m_elVideoPlayer;
	var parentOffset = $J(ele).offset();
	var barWidth = $J(ele).innerWidth();
	var relX = e.pageX - parentOffset.left;
	var nPercent =  relX / barWidth;

	var rgData = this.GetTimelineData();
	var nSeekTo = ((rgData.nTimeEnd - rgData.nTimeStart) * nPercent) + rgData.nTimeStart;

	if (this.m_player.BIsLiveContent())
	{
		nSeekTo = Math.min( nSeekTo, rgData.nBufferedEnd );
	}

	if ( this.m_player.BIsLiveContent() && ( rgData.nBufferedEnd - nSeekTo < CDASHPlayer.TRACK_BUFFER_MS / 1000 * 2 ) )
	{
		this.JumpToLive();
	}
	else
	{
		this.m_player.SeekTo( nSeekTo );
		this.m_bPlayingLiveEdge = false;
		this.OnTimeUpdatePlayer();
	}
}

CDASHPlayerUI.prototype.OnProgressHover = function( e, ele )
{
	if ( this.m_bHidden )
		return;

	var parentOffset = $J(ele).offset();
	var barWidth = $J(ele).innerWidth();
	var relX = e.pageX - parentOffset.left;
	var nPercent =  relX / barWidth;

	var rgData = this.GetTimelineData();
	var nSeekTo = ((rgData.nTimeEnd - rgData.nTimeStart) * nPercent) + rgData.nTimeStart;
	var strTime = "";

	if ( this.m_player.BIsLiveContent() )
	{
		nSeekTo = rgData.nBufferedEnd - nSeekTo;
		if ( nSeekTo < CDASHPlayer.TRACK_BUFFER_MS / 1000 * 2 )
			strTime = 'Live';
		else
			strTime = '-' + SecondsToTime( nSeekTo );
	}
	else
	{
		strTime = SecondsToTime( Math.min( Math.max( nSeekTo, 0 ), rgData.nTimeEnd ) );
	}

	var timeWidth = $J('.progress_time_info').outerWidth();
	var nTimeInfoLeft = Math.min( Math.max( relX - timeWidth / 2, -2 ), barWidth - timeWidth - 4 );

	$J('.progress_time_info').css('left', nTimeInfoLeft );
	$J('.progress_time_info .time_display').text( strTime );
	$J('.progress_time_bar').css('left', relX  );

	// if we have thumbnails to show
	if ( this.m_ThumbnailInfo && this.m_ThumbnailInfo.template )
	{
		// find the sprite sheet, the image in the sprite sheet and render it

		// note: don't try to get a thumbnail beyond the length of the video
		var nLastThumbnailTime = Math.floor( ( rgData.nTimeEnd - this.m_ThumbnailInfo.period ) / this.m_ThumbnailInfo.period ) * this.m_ThumbnailInfo.period;
		nSeekTo = Math.min( nSeekTo, nLastThumbnailTime );

		var nThumbnailSheetSeconds = Math.floor( nSeekTo / this.m_ThumbnailInfo.sheetSeconds ) * this.m_ThumbnailInfo.sheetSeconds;
		var nThumbnailIndexInSheet = Math.floor( ( nSeekTo - nThumbnailSheetSeconds ) / this.m_ThumbnailInfo.period );
		var nThumbnailWidth = $J( '.progress_time_info.thumbnails' ).innerWidth();
		var strThumbnailSheetURL = this.m_ThumbnailInfo.template.replace( '$Seconds$', nThumbnailSheetSeconds );
		var nXPosInSheet = -1 * nThumbnailWidth * nThumbnailIndexInSheet;

		$J( '.progress_time_info' ).css( 'background-image', 'url(\'' + strThumbnailSheetURL + '\')');
		$J( '.progress_time_info' ).css( 'background-position', nXPosInSheet + 'px 0px');
	}
}

CDASHPlayerUI.prototype.OnProgressLeave = function( e, ele )
{
		var nHoverHideLocation = ( -2 * $J( '.progress_time_info' ).outerWidth() ) + 'px';
	$J( '.progress_time_info' ).css( 'left', nHoverHideLocation );
	$J( '.progress_time_bar' ).css( 'left', nHoverHideLocation );
}

CDASHPlayerUI.prototype.LoadVolumeSettings = function()
{
	var nLastVolume = WebStorage.GetLocal('video_volume');
	if( nLastVolume == null )
		nLastVolume = 1;

	this.SetVolume( nLastVolume );

	var nLastMute = WebStorage.GetLocal('video_mute' );
	if ( nLastMute == null )
		nLastMute = false;

	if ( nLastMute != this.m_player.m_elVideoPlayer.muted )
		this.ToggleMute();
}


CDASHPlayerUI.prototype.ShowClosedCaptionOptions = function()
{
	if ( $J('.dash_closed_captions_customization').length == 0 )
	{
		this.InitClosedCaptionOptionDialog();
	}

	CDASHPlayerUI.LoadClosedCaptionOptions();
	$J('.dash_closed_captions_customization').show();
}

CDASHPlayerUI.prototype.InitClosedCaptionOptionDialog = function()
{
	this.m_elContainer.append('<div class="dash_closed_captions_customization"></div>');
	var ccDialog = $J( '.dash_closed_captions_customization' );
	ccDialog.append('<div class="cc_title">Caption Options</div>');

	// Steam/Chrome options we present, Safari captions options are controlled at the OS level, IE in the browser Internet Options
	if ( this.m_bIsSafariBrowser )
	{
		ccDialog.append('<div class="cc_style_instructions"><p>For Safari</p><br/>\n                                                 <ol>\n                                                     <li>From the Apple Menu, select System Preferences</li>\n                                                     <li>Click Accessibility</li>\n                                                     <li>Click Captions</li>\n                                                     <li>Select a pre-defined style or create a custom style by clicking +</li>\n                                                 </ol></div>');
	}
	else if ( this.m_bIsInternetExplorer )
	{
		ccDialog.append('<div class="cc_style_instructions"><p>For Internet Explorer</p><br/>\n                                                        <ol>\n                                                           <li>From the Tools Menu, select Internet options</li>\n                                                           <li>Click Accessibility</li>\n                                                           <li>Click Captions</li>\n                                                           <li>Turn on Ignore default caption fonts and colors</li>\n                                                           <li>Customize the font, font style and color as desired</li>\n                                                           <li>Click OK, OK, OK</li>\n                                                           <li>Restart the movie for the changes to take effect</li>\n                                                        </ol></div>');
	}
	else
	{
		this.AddClosedCaptionDropDown(ccDialog, 'Font Family:', 'font-family', [
													'Monospaced Serif|FreeMono, Courier New, Courier, monospace; font-variant: normal',
													'Proportional Serif|Georgia, Times New Roman, serif; font-variant: normal',
													'Monospaced Sans-Serif|Lucida Console, Monaco, DejaVu Sans Mono, Liberation Mono, monospace; font-variant: normal',
													'Proportional Sans-Serif|Helvetica, Arial, sans-serif; font-variant: normal',
													'Casual|Comic Sans MS, Segoe Print, Papyrus, Purisa, casual; font-variant: normal',
													'Cursive|Monotype Corsiva, Apple Chancery, Segoe Script, ITC Zapf Chancery, URW Chancery L, Brush Script MT, cursive; font-variant: normal',
													'Small Caps|Helvetica, Arial, sans-serif; font-variant: small-caps'
													], 3 );

		this.AddClosedCaptionDropDown(ccDialog, 'Font Color:', 'color', [
													'White|rgba(255,255,255,1)',
													'Yellow|rgba(255,255,0,1)',
													'Green|rgba(0,255,0,1)',
													'Cyan|rgba(0,255,255,1)',
													'Blue|rgba(0,0,255,1)',
													'Magenta|rgba(255,0,255,1)',
													'Red|rgba(255,0,0,1)',
													'Black|rgba(0,0,0,1)',
													], 0 );

		this.AddClosedCaptionDropDown(ccDialog, 'Font Size:', 'font-size', [
													'50%|50%',
													'75%|75%',
													'90%|90%',
													'100%|100%',
													'125%|125%',
													'150%|150%',
													'200%|200%',
													], 3 );

		this.AddClosedCaptionDropDown(ccDialog, 'Font Shadow:', 'text-shadow', [
													'None|none',
													'Drop Shadow|2px 2px 4px #000000',
													'Raised|0px 2px 1px #000000',
													'Depressed|0px -1px 0px #000000',
													'Uniform|0 0 2px #000000'
													], 0 );

		this.AddClosedCaptionDropDown(ccDialog, 'Line Height:', 'line-height', [
													'Automatic|inherit',
													'100%|100%',
													'105%|105%',
													'110%|110%',
													'115%|115%',
													'120%|120%',
													'125%|125%',
													'130%|130%',
													'140%|140%',
													'150%|150%'
													], 0 );

		this.AddClosedCaptionDropDown(ccDialog, 'Background Color:', 'background-color', [
													'White|rgba(255,255,255,0.8)',
													'Yellow|rgba(255,255,0,0.8)',
													'Green|rgba(0,255,0,0.8)',
													'Cyan|rgba(0,255,255,0.8)',
													'Blue|rgba(0,0,255,0.8)',
													'Magenta|rgba(255,0,255,0.8)',
													'Red|rgba(255,0,0,0.8)',
													'Black|rgba(0,0,0,0.8)',
													'None|Transparent'
													], 7 );

		this.AddClosedCaptionDropDown(ccDialog, 'Opacity:', 'opacity', [
													'25%|.25',
													'50%|.5',
													'75%|.75',
													'100%|1.0'
													], 3 );

		this.AddClosedCaptionDropDown(ccDialog, 'Text Wrap:', 'white-space', [
													'Default|pre-line',
													'Minimize|normal'
													], 0 );

		ccDialog.append('<div class="cc_cancel">Cancel</div>');

		// now get any saved values
		CDASHPlayerUI.LoadClosedCaptionOptions();
	}

	ccDialog.append('<div class="cc_done">Done</div>');

	$J( '.cc_cancel' ).on('click', function()
	{
		CDASHPlayerUI.LoadClosedCaptionOptions();
		$J('.dash_closed_captions_customization').hide();
	} );

	$J( '.cc_done' ).on('click', function()
	{
		CDASHPlayerUI.SaveClosedCaptionOptions();
		$J('.dash_closed_captions_customization').hide();
	} );
}

CDASHPlayerUI.prototype.AddClosedCaptionDropDown = function( dialog, strLabel, strCSSAttribute, rgValues, defaultValue )
{
	var newElement = '<div class="cc_select_wrapper">';
	newElement += '<span>' + strLabel + '</span>';
	newElement += '<select id="cc-' + strCSSAttribute + '">';

	for (var v = 0; v < rgValues.length; v++)
	{
		var rgKey = rgValues[v].split('|');
		if (rgKey.length == 2)
			newElement += '<option value="' + rgKey[1] + '" ' + ( v == defaultValue ? 'selected' : '') + '>' + rgKey[0] + "</option>"
		else
			newElement += '<option value="' + rgValues[v] + '"' + ( v == defaultValue ? 'selected' : '') + '>' + rgValues[v] + "</option>"
	}

	newElement += '</select>';
	newElement += '</div>';
	dialog.append(newElement);

	$J( '#cc-' + strCSSAttribute ).on('change', function()
	{
		CDASHPlayerUI.ChangeClosedCaptionDisplay( this.id.replace("cc-",""), this.value );
		this.blur();
	} );
}

CDASHPlayerUI.ChangeClosedCaptionDisplay = function( cueKey, cueValue )
{
	if ( window.VTTCue )
		document.styleSheets[document.styleSheets.length-1].addRule( '::cue', cueKey + ":" + cueValue );
}

CDASHPlayerUI.LoadClosedCaptionOptions = function()
{
	$J( '.dash_closed_captions_customization select' ).each( function ( index, element )
	{
		var value = WebStorage.GetLocal( element.id );
		if (value)
		{
			$J( '#' + element.id ).val(value).change();
		}
	});
}

CDASHPlayerUI.SaveClosedCaptionOptions = function()
{
	$J( '.dash_closed_captions_customization select' ).each( function ( index, element )
	{
		var elementId = '#' + element.id + ' option:selected';
		WebStorage.SetLocal( element.id, $J( elementId ).val() );
	});
}

CDASHPlayerUI.prototype.DisplayNotification = function( strNotification, nDisplayTimeMS )
{
	// hide any active notification
	if ( this.m_elActiveNotification )
	{
		this.m_elActiveNotification.remove();
		this.m_elActiveNotification = null;
	}

	if ( this.m_schNotificationTimeout )
	{
		clearTimeout( this.m_schNotificationTimeout );
		this.m_schNotificationTimeout = null;
	}

	var elNotification = $J( '<div class="playback_notification"><span></span></div>' );
	elNotification.find( 'span').text( strNotification );
	this.m_elContainer.append( elNotification );
	this.m_elActiveNotification = elNotification;

		FlushStyleChanges( elNotification );
	elNotification.addClass( 'show_notification' );

	var _ui = this;
	this.m_schNotificationTimeout = setTimeout( function() { _ui.CloseNotification(); }, nDisplayTimeMS );
}

CDASHPlayerUI.prototype.CloseNotification = function()
{
	this.m_schNotificationTimeout = null;
	if ( !this.m_elActiveNotification )
		return;

	var _ui = this;
	var elNotification = this.m_elActiveNotification;
	elNotification.one( 'transitionend webkitTransitionEnd oTransitionEnd MSTransitionEnd', function()
	{
		if ( _ui.m_elActiveNotification == elNotification )
			_ui.m_elActiveNotification = null;

		elNotification.remove();
	});

	elNotification.addClass( 'close_notification' );
}

function SecondsToTime( seconds )
{
	var hours = Math.floor( seconds / (60 * 60) );
	var minutes = Math.floor( seconds / 60 ) % 60;
	var seconds = Math.floor( seconds ) % 60;

	if( seconds < 10 )
		seconds = "0" + seconds;

	if ( minutes < 10 && hours > 0 )
		minutes = "0" + minutes;

	var out = (hours > 0 ) ? hours + ":" : "";
	return out + minutes + ":" + seconds;
}

function TimetoSeconds( strTime )
{
	// expecting 11:11:11.111
	var rgTimeComponents = strTime.split( ":"),
	compLength = rgTimeComponents.length - 1;

	var seconds = parseInt( rgTimeComponents[compLength-1] ) * 60 + parseFloat( rgTimeComponents[compLength] );

	if ( compLength === 2 )
	{
		seconds += parseInt( rgTimeComponents[0] ) * 3600;
	}

	return seconds;
}

//////////////////////////////////////////////////////////////////////////
// CVTTCaptionLoader for Parsing and Managing VTT Closed Caption Files
//////////////////////////////////////////////////////////////////////////
function CVTTCaptionLoader( elVideoPlayer, closedCaptions )
{
	this.m_elVideoPlayer = elVideoPlayer;
	this.m_rgClosedCaptions = closedCaptions;
	this.m_xhrDownloadVTT = null;
}

CVTTCaptionLoader.s_TrackOff = "disabled";
CVTTCaptionLoader.s_TrackHidden = "hidden";
CVTTCaptionLoader.s_TrackShowing = "showing";

CVTTCaptionLoader.prototype.Close = function()
{
	// stop any downloads
	if ( this.m_xhrDownloadVTT )
	{
		this.m_xhrDownloadVTT.abort();
		this.m_xhrDownloadVTT = null;
	}

	// clean up cues and turn off tracks
	for (var i = this.m_elVideoPlayer.textTracks.length - 1; i >= 0; i--)
	{
		if ( this.m_elVideoPlayer.textTracks[i].cues )
		{
			for (var c = this.m_elVideoPlayer.textTracks[i].cues.length - 1; c >=0; c--)
			{
				this.m_elVideoPlayer.textTracks[i].removeCue(this.m_elVideoPlayer.textTracks[i].cues[c]);
			}
		}

		this.m_elVideoPlayer.textTracks[i].mode = CVTTCaptionLoader.s_TrackOff;
	}

	this.m_rgClosedCaptions = [];
	this.m_elVideoPlayer = null;
}

CVTTCaptionLoader.prototype.SetAllTextTracksDisplay = function( trackState )
{
	for (var i = 0; i < this.m_elVideoPlayer.textTracks.length; i++ )
	{
		this.m_elVideoPlayer.textTracks[i].mode = trackState;
	}
}

CVTTCaptionLoader.prototype.GetTextTrackByCode = function( closedCaptionCode )
{
	for (var i = 0; i < this.m_elVideoPlayer.textTracks.length; i++ )
	{
		if ( this.m_elVideoPlayer.textTracks[i].label == closedCaptionCode )
			return this.m_elVideoPlayer.textTracks[i];
	}

	return null;
}

CVTTCaptionLoader.prototype.GetClosedCaptionUrl = function( closedCaptionCode )
{
	for (var i = 0; i < this.m_rgClosedCaptions.length; i++)
	{
		if ( this.m_rgClosedCaptions[i].code == closedCaptionCode )
			return this.m_rgClosedCaptions[i].url;
	}

	return null;
}

CVTTCaptionLoader.prototype.SwitchToTextTrack = function( closedCaptionCode )
{
	// turn off any current track
	this.SetAllTextTracksDisplay( CVTTCaptionLoader.s_TrackOff );

	// see if the requested text track exists, if so, turn it on
	var ccTextTrack = this.GetTextTrackByCode( closedCaptionCode );
	if ( ccTextTrack )
	{
		// .cues seems to only be filled in now after showing the track?
		ccTextTrack.mode = CVTTCaptionLoader.s_TrackShowing;
		if ( ccTextTrack.cues && ccTextTrack.cues.length )
			return true;
		else
			ccTextTrack.mode = CVTTCaptionLoader.s_TrackHidden;
	}

	// no text track or cues are empty so go get the VTT file
	var ccUrl = this.GetClosedCaptionUrl( closedCaptionCode );
	if ( ccUrl )
	{
		var _loader = this;
		this.m_xhrDownloadVTT = $J.ajax(
		{
			url: ccUrl,
			type: 'GET'
		})
		.done( function( data, status, xhr )
		{
			_loader.m_xhrDownloadVTT = null;

			var newTextTrack = _loader.AddVTTCuesToNewTrack ( data, closedCaptionCode );
			if ( !newTextTrack )
			{
				PlayerLog( 'Failed to parse VTT file ' + ccUrl );
				return false;
			}

			// show the text track
			newTextTrack.mode = CVTTCaptionLoader.s_TrackShowing;

		})
		.fail( function()
		{
			_loader.m_xhrDownloadVTT = null;
			PlayerLog( 'Failed to download: ' + ccUrl );
		});
	}
}

CVTTCaptionLoader.prototype.AddVTTCuesToNewTrack = function( data, closedCaptionCode )
{
	browserCue = window.VTTCue || window.TextTrackCue;

	// there may be a track but the cues are empty, so try to get it first and then create if needed
	var newTextTrack = this.GetTextTrackByCode( closedCaptionCode );
	if ( !newTextTrack )
		newTextTrack = this.m_elVideoPlayer.addTextTrack( "captions", closedCaptionCode, closedCaptionCode );

	var rgCuesFromVTT = this.ParseVTTForCues( data );
	if (rgCuesFromVTT.length == 0)
		return null;

	for (var c = 0; c < rgCuesFromVTT.length; c++)
	{
		if ( rgCuesFromVTT[c].startTime < rgCuesFromVTT[c].endTime )
		{
			var newCue = new browserCue( rgCuesFromVTT[c].startTime, rgCuesFromVTT[c].endTime, rgCuesFromVTT[c].captionText );

			// apply layout info if there is any
			for (var i = 0; i < rgCuesFromVTT[c].layout.length; i++)
			{
				var rgKeyVal = rgCuesFromVTT[c].layout[i].split(":");
				if (rgKeyVal.length == 2)
				{
					try
					{
						// skip size percentages as caption options don't scale with these
						if ( rgKeyVal[0].indexOf('size') == 0 && rgKeyVal[1].indexOf('%') != -1 )
							continue;

						// relative (percentage) screen attributes require snapToLines off
						if ( newCue.snapToLines && rgKeyVal[1].indexOf('%') != -1 )
						{
							newCue.snapToLines = false;
							rgKeyVal[1] = rgKeyVal[1].replace('%','');
						}

						// if the value is a number, then make sure the cue knows it's a number
						if ( !isNaN( parseFloat( rgKeyVal[1] ) ) )
							newCue[rgKeyVal[0]] = parseFloat( rgKeyVal[1] );
						else
							newCue[rgKeyVal[0]] = String( rgKeyVal[1] );
					}
					catch(e)
					{
						PlayerLog( 'VTTCue Error: ' + e.message );
						PlayerLog( rgCuesFromVTT[c] );
					}
				}
			}

			newTextTrack.addCue( newCue );
		}
		else
		{
			console.warn("TextTrack Cue " + c + " has a startTime (" + rgCuesFromVTT[c].startTime + ") after endTime (" + rgCuesFromVTT[c].endTime + ") and wasn't added.")
		}
	}

	return newTextTrack;
}

CVTTCaptionLoader.prototype.ParseVTTForCues = function ( cueData )
{
	var rgCues = [];

	var regExNewLine = /(?:\r\n|\r|\n)/gm,
		regExTimeSplit = /-->/,
		regExWhiteSpace = /(^[\s]+|[\s]+$)/g,
		regExInlineLayout = /{\\an[1-9]}/;

	var data = cueData.split( regExNewLine );

	for (var line = 0 ; line < data.length; line++)
	{
		var item = data[line];
		if (item.length > 0 && item !== "WEBVTT")
		{
			if (item.match( regExTimeSplit ) )
			{
				// get start and end time + optional layout information in VTT end cue section
				var cuePoints = item.split( regExTimeSplit );
				var startTime = cuePoints[0].replace(regExWhiteSpace, '');
				var rgEndCueElements = cuePoints[1].trim().split( " " );
				var endTime = rgEndCueElements[0];
				rgEndCueElements.splice( 0, 1 );
				var rgLayoutInfo = rgEndCueElements;

				// could be multiple caption text lines, get them all
				var captionLines = "";
				while ( line + 1 < data.length && data[line + 1].replace(regExWhiteSpace, "") != "")
				{
					// line break if more than one text line
					if (captionLines != "")
						captionLines += "\n";

					captionLines += data[++line];
				}

				// convert any layout info embedded in captionLines
				var rgFoundLayoutInfo = captionLines.match( regExInlineLayout );
				if ( rgFoundLayoutInfo )
				{
					captionLines = captionLines.replace( regExInlineLayout, '' );
					this.UpdateLayoutInfo( rgLayoutInfo, rgFoundLayoutInfo[0] );
				}

				var cueInfo = {
					startTime: TimetoSeconds( startTime ),
					endTime: TimetoSeconds( endTime ),
					captionText: captionLines,
					layout: rgLayoutInfo
				}

				rgCues.push( cueInfo );
			}
		}
	}

	return rgCues;
}

CVTTCaptionLoader.prototype.UpdateLayoutInfo = function( rgLayoutInfo, rgFoundLayoutInfo )
{
	// 3x3 grid, starting lower left to upper right.
	switch ( rgFoundLayoutInfo )
	{
		case "{\\an1}":
			rgLayoutInfo.push("line:99%");
			rgLayoutInfo.push("align:left");
			rgLayoutInfo.push("position:20%");
			break;
		case "{\\an2}":
			rgLayoutInfo.push("line:99%");
			rgLayoutInfo.push("align:middle");
			rgLayoutInfo.push("position:50%");
			break;
		case "{\\an3}":
			rgLayoutInfo.push("line:99%");
			rgLayoutInfo.push("align:right");
			rgLayoutInfo.push("position:80%");
			break;
		case "{\\an4}":
			rgLayoutInfo.push("line:50%");
			rgLayoutInfo.push("align:left");
			rgLayoutInfo.push("position:20%");
			break;
		case "{\\an5}":
			rgLayoutInfo.push("line:50%");
			rgLayoutInfo.push("align:middle");
			rgLayoutInfo.push("position:50%");
			break;
		case "{\\an6}":
			rgLayoutInfo.push("line:50%");
			rgLayoutInfo.push("align:right");
			rgLayoutInfo.push("position:80%");
			break;
		case "{\\an7}":
			rgLayoutInfo.push("line:10%");
			rgLayoutInfo.push("align:left");
			rgLayoutInfo.push("position:20%");
			break;
		case "{\\an8}":
			rgLayoutInfo.push("line:10%");
			rgLayoutInfo.push("align:middle");
			rgLayoutInfo.push("position:50%");
			break;
		case "{\\an9}":
			rgLayoutInfo.push("line:10%");
			rgLayoutInfo.push("align:right");
			rgLayoutInfo.push("position:80%");
			break;
		default:
			break;
	}
}

CVTTCaptionLoader.SortClosedCaptionsByDisplayLanguage = function(a,b) {
	if (a.display < b.display)
		return -1;
	if (a.display > b.display)
		return 1;

	return 0;
}

CVTTCaptionLoader.LanguageCountryCodes = {
    "bg-BG":{
        "displayName":"Български (Bulgarian)",
        "steamLanguage":"bulgarian"
    },
    "cs-CZ":{
        "displayName":"čeština (Czech)",
        "steamLanguage":"czech"
    },
    "da-DK":{
        "displayName":"Dansk (Danish)",
        "steamLanguage":"danish"
    },
    "en-US":{
        "displayName":"English",
        "steamLanguage":"english"
    },
    "fi-FI":{
        "displayName":"Suomi (Finnish)",
        "steamLanguage":"finnish"
    },
    "fr-FR":{
        "displayName":"Français (French)",
        "steamLanguage":"french"
    },
    "de-DE":{
        "displayName":"Deutsch (German)",
        "steamLanguage":"german"
    },
    "el-GR":{
        "displayName":"Ελληνικά (Greek)",
        "steamLanguage":"greek"
    },
    "es-ES":{
        "displayName":"Español (Spanish)",
        "steamLanguage":"spanish"
    },
    "hu-HU":{
        "displayName":"Magyar (Hungarian)",
        "steamLanguage":"hungarian"
    },
    "it-IT":{
        "displayName":"Italiano (Italian)",
        "steamLanguage":"italian"
    },
    "ja-JP":{
        "displayName":"日本語 (Japanese)",
        "steamLanguage":"japanese"
    },
    "ko-KR":{
        "displayName":"한국어 (Korean)",
        "steamLanguage":"koreana"
    },
    "nl-NL":{
        "displayName":"Nederlands (Dutch)",
        "steamLanguage":"dutch"
    },
    "nb-NO":{
        "displayName":"Norsk (Norwegian)",
        "steamLanguage":"norwegian"
    },
    "pl-PL":{
        "displayName":"Polski (Polish)",
        "steamLanguage":"polish"
    },
    "pt-BR":{
        "displayName":"Português-Brasil (Portuguese-Brazil)",
        "steamLanguage":"brazilian"
    },
    "pt-PT":{
        "displayName":"Português (Portuguese)",
        "steamLanguage":"portuguese"
    },
    "ro-RO":{
        "displayName":"Română (Romanian)",
        "steamLanguage":"romanian"
    },
    "ru-RU":{
        "displayName":"Русский (Russian)",
        "steamLanguage":"russian"
    },
    "sv-SE":{
        "displayName":"Svenska (Swedish)",
        "steamLanguage":"swedish"
    },
    "th-TH":{
        "displayName":"ไทย (Thai)",
        "steamLanguage":"thai"
    },
    "tr-TR":{
        "displayName":"Türkçe (Turkish)",
        "steamLanguage":"turkish"
    },
    "uk-UA":{
        "displayName":"Українська (Ukrainian)",
        "steamLanguage":"ukrainian"
    },
    "vi-VN":{
        "displayName":"tiếng Việt (Vietnamese)",
        "steamLanguage":"vietnamese"
    },
    "zh-CH":{
        "displayName":"简体中文 (Simplified Chinese)",
        "steamLanguage":"schinese"
	},
    "zh-CN":{
        "displayName":"繁體中文 (Traditional Chinese)",
        "steamLanguage":"tchinese"
    },
}

//////////////////////////////////////////////////
// Stats & Server Logging
//////////////////////////////////////////////////
CDASHPlayerStats = function( elVideoPlayer, videoPlayer, viewerSteamID )
{
	this.m_elVideoPlayer = elVideoPlayer;

	this.eleOverlay = $J('<div class="dash_player_playback_stats"></div>')[0];
	$J(this.m_elVideoPlayer).parent().append( this.eleOverlay );
	this.m_videoPlayer = videoPlayer;

	this.timerTick = false;
	this.timerSecond = false;
	this.nDecodedFramesPerSecond = 0;
	this.bRunning = false;

	this.strResolution = '';
	this.strVideoBuffered = '';
	this.strAudioBuffered = '';
	this.strBandwidth = '';
	this.strBuffers = '';

	// For Server Event Logging
	this.m_bAutoLoggingEventsToServer = ( Math.random() * 100 ) < CDASHPlayerStats.LOGGING_RATE_PERC;
	this.m_xhrLogEventToServer = null;
	this.m_steamID = viewerSteamID;
	this.m_statsLastSnapshot = {
		'time': new Date().getTime(),
		'bytes_received': 0,
		'frames_decoded': 0,
		'frames_dropped': 0,
		'failed_segments': 0,
	};

	// on screen reporting from stats report
	this.m_nStalledSegmentNumber = 0;
	this.m_nFailedSegmentResponse = 200;
	this.m_nCountStalls = 0;
	this.m_strVideoDownloadHost = '...';
	this.m_nReportedPlaybackPos = 0;
	this.m_fSegmentTimeAverage = 0;
	this.m_fBandwidthAverage = 0;

	// events that trigger server event logging
	var _stats = this;
	this.m_schNextLogEvent = null;
	if ( this.m_bAutoLoggingEventsToServer )
	{
		$J( this.m_elVideoPlayer ).on( 'voddownloadcomplete.DASHPlayerStats', function() { _stats.LogEventToServer( false, false ); });

		// set up for the first event logged
		this.m_schNextLogEvent = window.setTimeout( function() { _stats.LogEventToServer( false, false ); }, CDASHPlayerStats.LOG_FIRST_EVENT );
	}

	// always log stalled events
	$J( this.m_elVideoPlayer ).on( 'playbackstalled.DASHPlayerStats', function( e, bVideoStalled ) { _stats.LogEventToServer( true, bVideoStalled ); });
}

CDASHPlayerStats.LOGGING_RATE_PERC = 100;
CDASHPlayerStats.LOG_FIRST_EVENT = 1000 * 30; 	// 30 seconds
CDASHPlayerStats.LOG_NEXT_EVENT = 1000 * 300; 	// 5 minutes
CDASHPlayerStats.SEND_LOG_TO_SERVER = true;

CDASHPlayerStats.prototype.Close = function()
{
	$J( this.m_elVideoPlayer ).off( '.DASHPlayerStats' );

	clearTimeout( this.m_schNextLogEvent );

	if ( this.m_xhrLogEventToServer )
	{
		this.m_xhrLogEventToServer.abort();
		this.m_xhrLogEventToServer = null;
	}
}

CDASHPlayerStats.prototype.Reset = function()
{
	this.m_statsLastSnapshot = {
		'time': new Date().getTime(),
		'bytes_received': 0,
		'frames_decoded': 0,
		'frames_dropped': 0,
		'failed_segments': 0,
	};
}

CDASHPlayerStats.prototype.LogEventToServer = function( bStalledEvent, bVideoStalled )
{
	var _stats = this;

	var statsURL;
	if ( bStalledEvent )
		statsURL = CMPDParser.GetAnalyticsStalledLink();
	else
		statsURL = CMPDParser.GetAnalyticsStatsLink();

	if ( statsURL )
	{
		var statsCollected = this.CollectStatsForEvent( bStalledEvent, bVideoStalled );
		if ( Object.keys( statsCollected ).length )
		{
			// PlayerLog( statsCollected );

			if ( CDASHPlayerStats.SEND_LOG_TO_SERVER )
			{
				_stats.m_xhrLogEventToServer = $J.ajax(
				{
					url: statsURL,
					type: 'POST',
					data: statsCollected
				})
				.done( function( data, status, xhr )
				{
					_stats.m_xhrLogEventToServer = null;
				})
				.fail( function( jqXHR, textStatus, errorThrown )
				{
					_stats.m_xhrLogEventToServer = null;
				});
			}
		}

		// set up for the next log event
		if ( _stats.m_bAutoLoggingEventsToServer && !bStalledEvent )
		{
			clearTimeout( _stats.m_schNextLogEvent );
			_stats.m_schNextLogEvent = window.setTimeout( function() { _stats.LogEventToServer( false, false ); }, CDASHPlayerStats.LOG_NEXT_EVENT );
		}
	}
}

CDASHPlayerStats.prototype.CollectStatsForEvent = function( bStalledEvent, bVideoStalled )
{
	var statsCollected = {};

	if ( bStalledEvent )
	{
		statsCollected = this.m_videoPlayer.StatsRecentSegmentDownloads( bVideoStalled );

		// if the stalled segment is the same segment as last stall or the last segment error was 0 (request failed) or 404, no need to log.
		if ( statsCollected['last_segment_number'] == this.m_nStalledSegmentNumber || statsCollected['last_segment_response'] == 0 || statsCollected['last_segment_response'] == 404 )
			return {};

		this.m_nStalledSegmentNumber = statsCollected['segment_stalled'] = statsCollected['last_segment_number'];
		delete statsCollected['last_segment_number'];
		statsCollected['audio_stalled'] = !bVideoStalled;
		this.m_nCountStalls++;
	}
	else
	{
		var statsSnapshot = {
			'time': new Date().getTime(),
			'bytes_received': this.m_videoPlayer.StatsAllBytesReceived(),
			'frames_decoded': ( this.m_elVideoPlayer.webkitDecodedFrames || this.m_elVideoPlayer.webkitDecodedFrameCount ),
			'frames_dropped': ( this.m_elVideoPlayer.webkitDroppedFrames || this.m_elVideoPlayer.webkitDroppedFrameCount ),
			'failed_segments': this.m_videoPlayer.StatsAllFailedSegmentDownloads(),
		}

		// if the player hasn't played or downloaded since the last snapshot then nothing new to log
		if ( statsSnapshot['frames_decoded'] == this.m_statsLastSnapshot['frames_decoded'] && statsSnapshot['bytes_received'] == this.m_statsLastSnapshot['bytes_received'] )
			 return {};

		var bw_rates = this.m_videoPlayer.StatsBandwidthRates( true );
		var seg_times = this.m_videoPlayer.StatsSegmentDownloadTimes( true );

		statsCollected = {
			'video_buffer': Math.round( this.m_videoPlayer.StatsVideoBuffer() ),
			'audio_buffer': Math.round( this.m_videoPlayer.StatsAudioBuffer() ),
			'seconds_delta': Math.round( ( statsSnapshot['time'] - this.m_statsLastSnapshot['time'] ) / 1000 ),
			'bytes_received': statsSnapshot['bytes_received'] - this.m_statsLastSnapshot['bytes_received'],
			'frames_decoded': statsSnapshot['frames_decoded'] - this.m_statsLastSnapshot['frames_decoded'],
			'frames_dropped': statsSnapshot['frames_dropped'] - this.m_statsLastSnapshot['frames_dropped'],
			'failed_segments': statsSnapshot['failed_segments'] - this.m_statsLastSnapshot['failed_segments'],
			'bw_avg': Math.round( bw_rates['bw_avg'] ),
			'bw_min': Math.round( bw_rates['bw_min'] ),
			'bw_max': Math.round( bw_rates['bw_max'] ),
			'seg_time_avg': Number( seg_times['seg_avg'].toFixed(3) ),
			'seg_time_min': seg_times['seg_min'],
			'seg_time_max': seg_times['seg_max'],
		}

		// stats being displayed on screen
		this.m_fBandwidthAverage = statsCollected['bw_avg'];
		this.m_fSegmentTimeAverage = statsCollected['seg_time_avg'];
		this.m_nReportedPlaybackPos = this.m_videoPlayer.GetPlaybackTimeInSeconds();

		this.m_statsLastSnapshot = statsSnapshot;
	}

	// common for both log events
	statsCollected['steamid'] = this.m_steamID,
	statsCollected['host'] = this.m_strVideoDownloadHost = this.m_videoPlayer.StatsDownloadHost();
	statsCollected['playback_position'] = this.m_videoPlayer.GetPlaybackTimeInSeconds();
	statsCollected['playback_speed'] = this.m_videoPlayer.GetPlaybackRate();
	statsCollected['video_res'] = this.m_videoPlayer.StatsPlaybackHeight();
	statsCollected['audio_rate'] = Math.round ( this.m_videoPlayer.StatsAudioBitRate() );
	statsCollected['audio_ch'] = this.m_videoPlayer.StatsAudioChannels();

	return statsCollected;
}

//////////////////////
// On-Screen Events
//////////////////////

CDASHPlayerStats.prototype.Show = function()
{
	if( this.bRunning )
		return;

	this.bRunning = true;

	$J(this.eleOverlay).show();
	var context = this;
	this.timerTick = setInterval( function() { context.Tick() }, 1000/60 );
	this.timerCalculateTotals = setInterval(function() { context.CalculateTotals() }, 500);
}

CDASHPlayerStats.prototype.Hide = function()
{
	if( !this.bRunning )
		return;

	this.bRunning = false;

	$J(this.eleOverlay).hide();
	clearInterval(this.timerTick);
	clearInterval(this.timerCalculateTotals);
}

CDASHPlayerStats.prototype.Toggle = function()
{
	if( this.bRunning )
		this.Hide();
	else
		this.Show();
}

CDASHPlayerStats.prototype.CalculateTotals = function()
{
	// runs on a 500ms timer, so frame counts must be multiplied by 2.
	this.nDecodedFramesPerSecond = 2 * ( ( ele.mozDecodedFrames || ele.webkitDecodedFrames || ele.webkitDecodedFrameCount ) - ( this.nLastDecodedFrames || 0 ) )
	this.nLastDecodedFrames = ( ele.mozDecodedFrames || ele.webkitDecodedFrames || ele.webkitDecodedFrameCount );

	this.strResolution = this.m_videoPlayer.StatsPlaybackWidth() + 'x' + this.m_videoPlayer.StatsPlaybackHeight() + ' (' + $J(this.m_elVideoPlayer).innerWidth() + 'x' + $J(this.m_elVideoPlayer).innerHeight() + ')';
	this.strVideoBuffered = this.m_videoPlayer.StatsVideoBuffer() + 's';
	this.strAudioBuffered = this.m_videoPlayer.StatsAudioBuffer() + 's';
	this.strBandwidth = this.m_videoPlayer.StatsCurrentDownloadBitRate() * 1000;
	this.strBuffers = this.m_videoPlayer.StatsBufferInfo();
}

CDASHPlayerStats.prototype.FormattingBytesToHuman = function ( nBytes )
{
	if( nBytes < 1000 )
		return nBytes + " B";
	if( nBytes < 1000000 )
		return ( nBytes / 1000 ).toFixed(2) + ' KB';

	if( nBytes < 1000000000)
		return ( nBytes / 1000000 ).toFixed(2) + ' MB';

	return (nBytes / 1000000000 ).toFixed(2) + ' GB';
}

CDASHPlayerStats.prototype.Tick = function()
{
	$ele = $J(this.m_elVideoPlayer);
	ele = this.m_elVideoPlayer;
	var rgStatsDefinitions = [
		// Webkit
		{
			id: 'webkitAudioBytesDecoded',
			label: 'Audio Bytes Decoded',
			value: ele.webkitAudioBytesDecoded || ele.webkitAudioDecodedByteCount,
			formatFunc: this.FormattingBytesToHuman
		},
		{
			id: 'webkitVideoBytesDecoded',
			label: 'Video Bytes Decoded',
			value: ele.webkitVideoBytesDecoded || ele.webkitVideoDecodedByteCount,
			formatFunc: this.FormattingBytesToHuman
		},
		{
			id: 'webkitDecodedFrames',
			label: 'Decoded Frames',
			value: ele.webkitDecodedFrames || ele.webkitDecodedFrameCount
		},
		{
			id: 'webkitDroppedFrames',
			label: 'Dropped Frames',
			value: ele.webkitDroppedFrames || ele.webkitDroppedFrameCount
		},
		// Firefox
		{
			id: 'mozParsedFrames',
			label: 'Parsed Frames',
			value: ele.mozParsedFrames
		},
		{
			id: 'mozDecodedFrames',
			label: 'Decoded Frames',
			value: ele.mozDecodedFrames
		},
		{
			id: 'mozPresentedFrames',
			label: 'Presented Frames',
			value: ele.mozPresentedFrames
		},
		{
			id: 'mozPaintedFrames',
			label: 'Painted Frames',
			value: ele.mozPaintedFrames
		},
		{
			id: 'mozFrameDelay',
			label: 'Frame Delay',
			value: ele.mozFrameDelay
		},
		// Generic
		{
			id: 'decodedFramesPerSecond',
			label: 'Decoded Frames Per Second',
			value: this.nDecodedFramesPerSecond
		},
		// DASHPlayer
		{
			id: 'playbackResolution',
			label: 'Resolution',
			value: this.strResolution
		},
		{
			id: 'videobuffered',
			label: 'Video Buffered',
			value: this.strVideoBuffered
		},
		{
			id: 'audiobuffered',
			label: 'Audio Buffered',
			value: this.strAudioBuffered
		},
		{
			id: 'downloadbandwidth',
			label: 'Bandwidth (bits)',
			value: this.strBandwidth,
			formatFunc: this.FormattingBytesToHuman
		},
		{
			id: 'dashbuffers',
			label: 'Buffers',
			value: this.strBuffers
		},
		// Report Stats
		{
			id: 'stalls',
			label: 'Stalled Events',
			value: this.m_nCountStalls
		},
		{
			id: 'reportsent',
			label: 'Stats Sent',
			value: SecondsToTime( this.m_nReportedPlaybackPos )
		},
		{
			id: 'host',
			label: ' - Host',
			value: this.m_strVideoDownloadHost
		},
		{
			id: 'bandwidthavg',
			label: ' - Bandwidth Average (bits)',
			value: this.m_fBandwidthAverage,
			formatFunc: this.FormattingBytesToHuman
		},
		{
			id: 'segmentfails',
			label: ' - Segment D/L Fails',
			value: this.m_statsLastSnapshot['failed_segments']
		},
		{
			id: 'segmenttimeaverage',
			label: ' - Segment D/L Time Average',
			value: this.m_fSegmentTimeAverage + 's'
		}
];

	for( var i=0; i < rgStatsDefinitions.length; i++)
	{
		var rgStatDefinition = rgStatsDefinitions[i];
		if( rgStatDefinition.value != undefined && rgStatDefinition.value != NaN )
		{
			$target = $J( '.value', $J('#' + rgStatDefinition.id) );
			// Create element if needed
			if( $target.length == 0 )
			{
				var container = $J('<div id="'+rgStatDefinition.id+'">' + rgStatDefinition.label + ': <span class="value"></span></div>');
				$J(this.eleOverlay).append( container );
				$target = $J( '.value', container );
			}

			if( rgStatDefinition.formatFunc )
				$target.text( rgStatDefinition.formatFunc( rgStatDefinition.value ) );
			else
				$target.html( rgStatDefinition.value );
		}
	}
}



