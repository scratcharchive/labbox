import os
import json
import time
import hashlib
from typing import Dict, Set, Union

import hither as hi
import kachery as ka
import kachery_p2p as kp
import numpy as np

job_cache_path = os.environ['KACHERY_STORAGE_DIR'] + '/job-cache'
if not os.path.exists(job_cache_path):
    os.mkdir(job_cache_path)
job_cache=hi.JobCache(path=job_cache_path)

class LabboxContext:
    def __init__(self, worker_session):
        self._worker_session = worker_session
    def get_job_cache(self):
        return job_cache
    def get_job_handler(self, job_handler_name):
        return self._worker_session._get_job_handler_from_name(job_handler_name)

class WorkerSession:
    def __init__(self, *, labbox_config):
        self._labbox_config = labbox_config
        self._local_job_handlers = dict(
            default=hi.ParallelJobHandler(4),
            partition1=hi.ParallelJobHandler(4),
            partition2=hi.ParallelJobHandler(4),
            partition3=hi.ParallelJobHandler(4),
            timeseries=hi.ParallelJobHandler(4)
        )
        self._default_job_cache = job_cache
        self._labbox_context = LabboxContext(worker_session=self)

        self._default_feed_id = kp.get_feed_id(os.environ['LABBOX_DEFAULT_FEED_NAME'], create=True)
        self._readonly = False
        self._jobs_by_id = {}
        self._remote_job_handlers = {}
        self._on_messages_callbacks = []
        self._subfeed_message_requests = {}

    def initialize(self):
        node_id = kp.get_node_id()

        server_info = {
            'nodeId': node_id,
            'defaultFeedId': self._default_feed_id,
            'labboxConfig': self._labbox_config
        }
        msg = {
            'type': 'reportServerInfo',
            'serverInfo': server_info
        }
        self._send_message(msg)
    def cleanup(self):
        # todo
        pass
    def handle_message(self, msg):
        type0 = msg.get('type')
        if type0 == 'hitherCreateJob':
            functionName = msg['functionName']
            kwargs = msg['kwargs']
            client_job_id = msg['clientJobId']
            try:
                outer_job = hi.run(functionName, **kwargs, labbox=self._labbox_context)
            except Exception as err:
                self._send_message({
                    'type': 'hitherJobError',
                    'job_id': client_job_id,
                    'client_job_id': client_job_id,
                    'error_message': f'Error creating outer job: {str(err)}',
                    'runtime_info': None
                })
                return
            try:
                job_or_result = outer_job.wait()
            except Exception as err:
                self._send_message({
                    'type': 'hitherJobError',
                    'job_id': outer_job._job_id,
                    'client_job_id': client_job_id,
                    'error_message': str(err),
                    'runtime_info': outer_job.get_runtime_info()
                })
                return
            if hasattr(job_or_result, '_job_id'):
                job = job_or_result
                setattr(job, '_client_job_id', client_job_id)
                job_id = job._job_id
                self._jobs_by_id[job_id] = job
                print(f'======== Created hither job (2): {job_id} {functionName}')
                self._send_message({
                    'type': 'hitherJobCreated',
                    'job_id': job_id,
                    'client_job_id': client_job_id
                })
            else:
                result = job_or_result
                msg = {
                    'type': 'hitherJobFinished',
                    'client_job_id': client_job_id,
                    'job_id': client_job_id,
                    # 'result': _make_json_safe(result),
                    'result_sha1': ka.get_file_hash(ka.store_object(_make_json_safe(result))),
                    'runtime_info': outer_job.get_runtime_info()
                }
        elif type0 == 'hitherCancelJob':
            job_id = msg['job_id']
            assert job_id, 'Missing job_id'
            assert job_id in self._jobs_by_id, f'No job with id: {job_id}'
            job = self._jobs_by_id[job_id]
            job.cancel()
        elif type0 == 'subfeedMessageRequest':
            request_id = msg['requestId']
            feed_uri = msg['feedUri']
            if not feed_uri: feed_uri = 'feed://' + self._default_feed_id
            subfeed_name = msg['subfeedName']
            position = msg['position']
            wait_msec = msg['waitMsec']
            self._subfeed_message_requests[request_id] = {
                'feed_uri': feed_uri,
                'subfeed_name': subfeed_name,
                'position': position,
                'wait_msec': wait_msec,
                'timestamp': time.time()
            }

    def iterate(self):
        while True:
            found_something = False
            subfeed_message_request_ids = list(self._subfeed_message_requests.keys())
            if len(subfeed_message_request_ids) > 0:
                msgs_for_client = []
                subfeed_watches = {}
                for smr_id in subfeed_message_request_ids:
                    smr = self._subfeed_message_requests[smr_id]
                    subfeed_watches[smr_id] = {
                        'position': smr['position'],
                        'feedId': _feed_id_from_uri(smr['feed_uri']),
                        'subfeedHash': _subfeed_hash_from_name(smr['subfeed_name'])
                    }
                messages = kp.watch_for_new_messages(subfeed_watches=subfeed_watches, wait_msec=100)
                resolved_subfeed_message_requests: Set[str] = set()
                for watch_name in messages.keys():
                    num_new_messages = len(messages[watch_name])
                    if num_new_messages > 0:
                        found_something = True
                        msgs_for_client.append({
                            'type': 'subfeedMessageRequestResponse',
                            'requestId': watch_name,
                            'numNewMessages': num_new_messages
                        })
                        resolved_subfeed_message_requests.add(watch_name)
                for smr_id in subfeed_message_request_ids:
                    if not smr_id in resolved_subfeed_message_requests:
                        smr = self._subfeed_message_requests[smr_id]
                        elapsed_msec = (time.time() - smr['timestamp']) * 1000
                        if elapsed_msec > smr['wait_msec']:
                            msgs_for_client.append({
                                'type': 'subfeedMessageRequestResponse',
                                'requestId': watch_name,
                                'numNewMessages': 0
                            })
                            resolved_subfeed_message_requests.add(watch_name)
                
                if len(msgs_for_client) > 0:
                    self._send_messages(msgs_for_client)
                    for smr_id in resolved_subfeed_message_requests:
                        del self._subfeed_message_requests[smr_id]
            if not found_something:
                break
        
        hi.wait(0)
        job_ids = list(self._jobs_by_id.keys())
        for job_id in job_ids:
            job = self._jobs_by_id[job_id]
            status0 = job.get_status()
            if status0 == hi.JobStatus.FINISHED:
                print(f'======== Finished hither job: {job_id} {job.get_label()}')
                result = job.get_result()
                runtime_info = job.get_runtime_info()
                del self._jobs_by_id[job_id]
                msg = {
                    'type': 'hitherJobFinished',
                    'client_job_id': job._client_job_id,
                    'job_id': job_id,
                    # 'result': _make_json_safe(result),
                    'result_sha1': ka.get_file_hash(ka.store_object(_make_json_safe(result))),
                    'runtime_info': runtime_info
                }
                self._send_message(msg)
            elif status0 == hi.JobStatus.ERROR:
                exc = job.get_exception()
                runtime_info = job.get_runtime_info()
                del self._jobs_by_id[job_id]
                msg = {
                    'type': 'hitherJobError',
                    'job_id': job_id,
                    'client_job_id': job._client_job_id,
                    'error_message': str(exc),
                    'runtime_info': runtime_info
                }
                self._send_message(msg)
    def on_messages(self, callback):
        self._on_messages_callbacks.append(callback)
    def _send_message(self, msg):
        for cb in self._on_messages_callbacks:
            cb([msg])
    def _send_messages(self, msgs):
        for cb in self._on_messages_callbacks:
            cb(msgs)
    def _get_job_handler_from_name(self, job_handler_name):
        assert job_handler_name in self._labbox_config['job_handlers'], f'Job handler not found in config: {job_handler_name}'
        a = self._labbox_config['job_handlers'][job_handler_name]
        compute_resource_uri = self._labbox_config.get('compute_resource_uri', '')
        if a['type'] == 'local':
            jh = self._local_job_handlers[job_handler_name]
        elif a['type'] == 'remote':
            jh = self._get_remote_job_handler(job_handler_name=job_handler_name, uri=compute_resource_uri)
        else:
            raise Exception(f'Unexpected job handler type: {a["type"]}')
        return jh
    def _get_remote_job_handler(self, job_handler_name, uri):
        if job_handler_name not in self._remote_job_handlers:
            self._remote_job_handlers[job_handler_name] = hi.RemoteJobHandler(compute_resource_uri=uri)
        return self._remote_job_handlers[job_handler_name]

def _make_json_safe(x):
    if isinstance(x, np.integer):
        return int(x)
    elif isinstance(x, np.floating):
        return float(x)
    elif type(x) == dict:
        ret = dict()
        for key, val in x.items():
            ret[key] = _make_json_safe(val)
        return ret
    elif (type(x) == list) or (type(x) == tuple):
        return [_make_json_safe(val) for val in x]
    elif isinstance(x, np.ndarray):
        raise Exception('Cannot make ndarray json safe')
    else:
        if _is_jsonable(x):
            # this will capture int, float, str, bool
            return x
    raise Exception(f'Item is not json safe: {type(x)}')

def _is_jsonable(x) -> bool:
    import json
    try:
        json.dumps(x)
        return True
    except:
        return False

def _feed_id_from_uri(uri: str):
    a = uri.split('/')
    return a[2]

def _subfeed_hash_from_uri(uri: str):
    a = uri.split('/')
    n = a[3]
    return _subfeed_hash_from_name(n)

def _subfeed_hash_from_name(subfeed_name: Union[str, dict]):
    if isinstance(subfeed_name, str):
        if subfeed_name.startswith('~'):
            return subfeed_name[1:]
        return _sha1_of_string(subfeed_name)
    else:
        return _sha1_of_object(subfeed_name)

def _sha1_of_string(txt: str) -> str:
    hh = hashlib.sha1(txt.encode('utf-8'))
    ret = hh.hexdigest()
    return ret

def _sha1_of_object(obj: object) -> str:
    txt = json.dumps(obj, sort_keys=True, separators=(',', ':'))
    return _sha1_of_string(txt)