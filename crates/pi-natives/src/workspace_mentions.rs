//! Handle-relative workspace file-mention reads.
//!
//! A strict reader verifies the workspace root once, retains that directory
//! handle, and resolves every later component relative to retained handles.
//! No strict read reopens the workspace root through an ambient path.

use std::{io, sync::Mutex};

use napi::{Error, Result, Status, bindgen_prelude::Buffer};
use napi_derive::napi;

const MAX_TEXT_BYTES: usize = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES: usize = 500;

#[napi(object)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceRootIdentity {
	pub platform: String,
	pub volume_id: String,
	pub file_id: String,
}

#[napi(object)]
#[derive(Clone, Debug, PartialEq)]
pub struct WorkspaceMentionDirectoryEntry {
	pub name: String,
	pub is_directory: bool,
	pub modified_at_ms: Option<f64>,
}

#[napi(object)]
pub struct WorkspaceMentionReadResult {
	pub kind: String,
	pub data: Option<Buffer>,
	pub entries: Option<Vec<WorkspaceMentionDirectoryEntry>>,
	pub byte_size: Option<f64>,
	pub reason: Option<String>,
	pub entry_limit_reached: Option<bool>,
}

impl WorkspaceMentionReadResult {
	fn file(data: Vec<u8>) -> Self {
		let byte_size = data.len() as f64;
		Self {
			kind: "file".to_string(),
			data: Some(data.into()),
			entries: None,
			byte_size: Some(byte_size),
			reason: None,
			entry_limit_reached: None,
		}
	}

	fn directory(entries: Vec<WorkspaceMentionDirectoryEntry>, entry_limit_reached: bool) -> Self {
		Self {
			kind: "directory".to_string(),
			data: None,
			entries: Some(entries),
			byte_size: None,
			reason: None,
			entry_limit_reached: Some(entry_limit_reached),
		}
	}

	fn skipped(reason: SkipReason, byte_size: Option<u64>) -> Self {
		Self {
			kind: "skipped".to_string(),
			data: None,
			entries: None,
			byte_size: byte_size.map(|size| size as f64),
			reason: Some(reason.as_str().to_string()),
			entry_limit_reached: None,
		}
	}
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SkipReason {
	Disposed,
	InvalidPath,
	Missing,
	UnsafeSymlink,
	UnsupportedEntry,
	TooLarge,
	IoError,
}

impl SkipReason {
	const fn as_str(self) -> &'static str {
		match self {
			Self::Disposed => "disposed",
			Self::InvalidPath => "invalidPath",
			Self::Missing => "missing",
			Self::UnsafeSymlink => "unsafeSymlink",
			Self::UnsupportedEntry => "unsupportedEntry",
			Self::TooLarge => "tooLarge",
			Self::IoError => "ioError",
		}
	}
}

enum MaterializedMention {
	File(Vec<u8>),
	Directory { entries: Vec<WorkspaceMentionDirectoryEntry>, entry_limit_reached: bool },
	Skipped { reason: SkipReason, byte_size: Option<u64> },
}

fn parse_relative_segments(relative_path: &str) -> std::result::Result<Vec<&str>, SkipReason> {
	if relative_path.is_empty()
		|| relative_path.starts_with('/')
		|| relative_path.starts_with('\\')
		|| relative_path.contains('\\')
		|| relative_path.contains('\0')
	{
		return Err(SkipReason::InvalidPath);
	}
	let segments: Vec<&str> = relative_path.split('/').collect();
	if segments
		.iter()
		.any(|segment| segment.is_empty() || *segment == "." || *segment == "..")
	{
		return Err(SkipReason::InvalidPath);
	}
	Ok(segments)
}

fn supported_image_header(bytes: &[u8]) -> bool {
	bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a])
		|| bytes.starts_with(&[0xff, 0xd8, 0xff])
		|| bytes.starts_with(b"GIF87a")
		|| bytes.starts_with(b"GIF89a")
		|| (bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"))
}

fn materialized_result(materialized: MaterializedMention) -> WorkspaceMentionReadResult {
	match materialized {
		MaterializedMention::File(data) => WorkspaceMentionReadResult::file(data),
		MaterializedMention::Directory { entries, entry_limit_reached } => {
			WorkspaceMentionReadResult::directory(entries, entry_limit_reached)
		},
		MaterializedMention::Skipped { reason, byte_size } => {
			WorkspaceMentionReadResult::skipped(reason, byte_size)
		},
	}
}

fn identity_error(message: &'static str) -> Error {
	Error::new(Status::GenericFailure, message)
}

#[napi]
pub fn read_workspace_mention_root_identity(
	workspace_root: String,
) -> Result<WorkspaceRootIdentity> {
	platform::read_root_identity(&workspace_root)
		.map_err(|_| identity_error("workspace root must be an accessible non-symlink directory"))
}

#[napi]
pub struct StrictWorkspaceMentionReader {
	root: Mutex<Option<platform::RootHandle>>,
}

#[napi]
impl StrictWorkspaceMentionReader {
	#[napi(constructor)]
	pub fn new(workspace_root: String, expected_identity: WorkspaceRootIdentity) -> Result<Self> {
		let root =
			platform::open_verified_root(&workspace_root, &expected_identity).map_err(|error| {
				if error.kind() == io::ErrorKind::InvalidData {
					identity_error("workspace root identity mismatch")
				} else {
					identity_error("workspace root must be an accessible non-symlink directory")
				}
			})?;
		Ok(Self { root: Mutex::new(Some(root)) })
	}

	#[napi]
	pub fn read(&self, relative_path: String) -> WorkspaceMentionReadResult {
		let segments = match parse_relative_segments(&relative_path) {
			Ok(segments) => segments,
			Err(reason) => return WorkspaceMentionReadResult::skipped(reason, None),
		};
		let guard = self
			.root
			.lock()
			.unwrap_or_else(std::sync::PoisonError::into_inner);
		let Some(root) = guard.as_ref() else {
			return WorkspaceMentionReadResult::skipped(SkipReason::Disposed, None);
		};
		materialized_result(platform::read(root, &segments))
	}

	#[napi]
	pub fn dispose(&self) -> bool {
		self
			.root
			.lock()
			.unwrap_or_else(std::sync::PoisonError::into_inner)
			.take()
			.is_some()
	}
}

impl Drop for StrictWorkspaceMentionReader {
	fn drop(&mut self) {
		let _ = self
			.root
			.get_mut()
			.unwrap_or_else(std::sync::PoisonError::into_inner)
			.take();
	}
}

#[cfg(unix)]
mod platform {
	use std::{
		ffi::{CStr, CString, OsStr},
		fs::File,
		io::{self, Read},
		os::{
			fd::{AsRawFd, FromRawFd, OwnedFd},
			unix::ffi::OsStrExt,
		},
	};

	use super::{
		MAX_DIRECTORY_ENTRIES, MAX_IMAGE_BYTES, MAX_TEXT_BYTES, MaterializedMention, SkipReason,
		WorkspaceMentionDirectoryEntry, WorkspaceRootIdentity, supported_image_header,
	};

	pub struct RootHandle(OwnedFd);

	pub fn read_root_identity(workspace_root: &str) -> io::Result<WorkspaceRootIdentity> {
		let root = open_root(workspace_root)?;
		identity_for_fd(root.as_raw_fd())
	}

	pub fn open_verified_root(
		workspace_root: &str,
		expected: &WorkspaceRootIdentity,
	) -> io::Result<RootHandle> {
		if expected.platform != "posix" {
			return Err(io::Error::new(io::ErrorKind::InvalidData, "identity platform mismatch"));
		}
		let root = open_root(workspace_root)?;
		let actual = identity_for_fd(root.as_raw_fd())?;
		if actual != *expected {
			return Err(io::Error::new(
				io::ErrorKind::InvalidData,
				"workspace root identity mismatch",
			));
		}
		Ok(RootHandle(root))
	}

	fn open_root(workspace_root: &str) -> io::Result<OwnedFd> {
		let path = CString::new(OsStr::new(workspace_root).as_bytes())
			.map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "workspace root contains NUL"))?;
		// SAFETY: `path` is NUL-terminated and the returned descriptor is adopted
		// exactly once below.
		let fd = unsafe {
			libc::open(
				path.as_ptr(),
				libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
			)
		};
		if fd < 0 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: `fd` was returned by `open` and ownership transfers here.
		Ok(unsafe { OwnedFd::from_raw_fd(fd) })
	}

	fn identity_for_fd(fd: libc::c_int) -> io::Result<WorkspaceRootIdentity> {
		let mut status = std::mem::MaybeUninit::<libc::stat>::uninit();
		// SAFETY: `status` points to writable storage and `fd` is open.
		if unsafe { libc::fstat(fd, status.as_mut_ptr()) } != 0 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: successful `fstat` initialized `status`.
		let status = unsafe { status.assume_init() };
		if status.st_mode & libc::S_IFMT != libc::S_IFDIR {
			return Err(io::Error::new(
				io::ErrorKind::InvalidInput,
				"workspace root is not a directory",
			));
		}
		Ok(WorkspaceRootIdentity {
			platform: "posix".to_string(),
			volume_id: status.st_dev.to_string(),
			file_id: status.st_ino.to_string(),
		})
	}

	pub fn read(root: &RootHandle, segments: &[&str]) -> MaterializedMention {
		let target = match open_relative(root.0.as_raw_fd(), segments) {
			Ok(target) => target,
			Err(reason) => return MaterializedMention::Skipped { reason, byte_size: None },
		};
		let status = match status_for_fd(target.as_raw_fd()) {
			Ok(status) => status,
			Err(_) => {
				return MaterializedMention::Skipped { reason: SkipReason::IoError, byte_size: None };
			},
		};
		match status.st_mode & libc::S_IFMT {
			libc::S_IFREG => read_file(target, status.st_size.max(0) as u64),
			libc::S_IFDIR => read_directory(target),
			_ => {
				MaterializedMention::Skipped { reason: SkipReason::UnsupportedEntry, byte_size: None }
			},
		}
	}

	fn open_relative(
		root_fd: libc::c_int,
		segments: &[&str],
	) -> std::result::Result<OwnedFd, SkipReason> {
		let mut parent: Option<OwnedFd> = None;
		for (index, segment) in segments.iter().enumerate() {
			let name = CString::new(*segment).map_err(|_| SkipReason::InvalidPath)?;
			let parent_fd = parent.as_ref().map_or(root_fd, AsRawFd::as_raw_fd);
			let status = status_at(parent_fd, &name)?;
			if status.st_mode & libc::S_IFMT == libc::S_IFLNK {
				return Err(SkipReason::UnsafeSymlink);
			}
			let is_final = index + 1 == segments.len();
			if !is_final && status.st_mode & libc::S_IFMT != libc::S_IFDIR {
				return Err(SkipReason::UnsupportedEntry);
			}
			let mut flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK;
			if !is_final {
				flags |= libc::O_DIRECTORY;
			}
			// SAFETY: `parent_fd` is an open directory and `name` is NUL-terminated.
			let fd = unsafe { libc::openat(parent_fd, name.as_ptr(), flags) };
			if fd < 0 {
				return Err(map_open_error(io::Error::last_os_error()));
			}
			// SAFETY: `fd` was returned by `openat` and ownership transfers here.
			parent = Some(unsafe { OwnedFd::from_raw_fd(fd) });
		}
		parent.ok_or(SkipReason::InvalidPath)
	}

	fn status_at(
		parent_fd: libc::c_int,
		name: &CStr,
	) -> std::result::Result<libc::stat, SkipReason> {
		let mut status = std::mem::MaybeUninit::<libc::stat>::uninit();
		// SAFETY: arguments are valid and `AT_SYMLINK_NOFOLLOW` prevents traversal.
		if unsafe {
			libc::fstatat(parent_fd, name.as_ptr(), status.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW)
		} != 0
		{
			return Err(map_open_error(io::Error::last_os_error()));
		}
		// SAFETY: successful `fstatat` initialized `status`.
		Ok(unsafe { status.assume_init() })
	}

	fn status_for_fd(fd: libc::c_int) -> io::Result<libc::stat> {
		let mut status = std::mem::MaybeUninit::<libc::stat>::uninit();
		// SAFETY: `status` is writable and `fd` is open.
		if unsafe { libc::fstat(fd, status.as_mut_ptr()) } != 0 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: successful `fstat` initialized `status`.
		Ok(unsafe { status.assume_init() })
	}

	fn map_open_error(error: io::Error) -> SkipReason {
		match error.raw_os_error() {
			Some(libc::ENOENT) => SkipReason::Missing,
			Some(libc::ELOOP) => SkipReason::UnsafeSymlink,
			Some(libc::ENOTDIR) => SkipReason::UnsupportedEntry,
			_ => SkipReason::IoError,
		}
	}

	fn read_file(target: OwnedFd, reported_size: u64) -> MaterializedMention {
		let mut file = File::from(target);
		let mut data = Vec::with_capacity(reported_size.min(MAX_IMAGE_BYTES as u64) as usize);
		let mut header = [0u8; 12];
		let mut header_len = 0usize;
		while header_len < header.len() {
			match file.read(&mut header[header_len..]) {
				Ok(0) => break,
				Ok(read) => header_len += read,
				Err(_) => {
					return MaterializedMention::Skipped {
						reason: SkipReason::IoError,
						byte_size: None,
					};
				},
			}
		}
		data.extend_from_slice(&header[..header_len]);
		let max_bytes = if supported_image_header(&data) {
			MAX_IMAGE_BYTES
		} else {
			MAX_TEXT_BYTES
		};
		if reported_size > max_bytes as u64 {
			return MaterializedMention::Skipped {
				reason: SkipReason::TooLarge,
				byte_size: Some(reported_size),
			};
		}
		let remaining = max_bytes.saturating_add(1).saturating_sub(data.len());
		if file
			.by_ref()
			.take(remaining as u64)
			.read_to_end(&mut data)
			.is_err()
		{
			return MaterializedMention::Skipped { reason: SkipReason::IoError, byte_size: None };
		}
		if data.len() > max_bytes {
			return MaterializedMention::Skipped {
				reason: SkipReason::TooLarge,
				byte_size: Some(data.len() as u64),
			};
		}
		MaterializedMention::File(data)
	}

	fn read_directory(target: OwnedFd) -> MaterializedMention {
		// SAFETY: duplicating an owned directory descriptor yields an independent
		// descriptor which `fdopendir` takes ownership of.
		let duplicate = unsafe { libc::fcntl(target.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) };
		if duplicate < 0 {
			return MaterializedMention::Skipped { reason: SkipReason::IoError, byte_size: None };
		}
		// SAFETY: `duplicate` is an owned directory descriptor.
		let directory = unsafe { libc::fdopendir(duplicate) };
		if directory.is_null() {
			// SAFETY: `fdopendir` did not take ownership on failure.
			unsafe { libc::close(duplicate) };
			return MaterializedMention::Skipped { reason: SkipReason::IoError, byte_size: None };
		}

		let mut entries = Vec::new();
		let mut entry_limit_reached = false;
		loop {
			// SAFETY: `directory` remains valid until `closedir` below.
			let raw = unsafe { libc::readdir(directory) };
			if raw.is_null() {
				break;
			}
			// SAFETY: `raw` points to the current directory entry and `d_name` is
			// NUL-terminated by `readdir`.
			let name = unsafe { CStr::from_ptr((*raw).d_name.as_ptr()) };
			if name.to_bytes() == b"." || name.to_bytes() == b".." {
				continue;
			}
			let Ok(name_text) = name.to_str() else {
				continue;
			};
			let Ok(status) = status_at(target.as_raw_fd(), name) else {
				continue;
			};
			let file_type = status.st_mode & libc::S_IFMT;
			if file_type == libc::S_IFLNK || (file_type != libc::S_IFREG && file_type != libc::S_IFDIR)
			{
				continue;
			}
			entries.push(WorkspaceMentionDirectoryEntry {
				name: name_text.to_string(),
				is_directory: file_type == libc::S_IFDIR,
				modified_at_ms: modified_at_ms(&status),
			});
			if entries.len() > MAX_DIRECTORY_ENTRIES {
				entry_limit_reached = true;
				break;
			}
		}
		// SAFETY: `directory` was returned by `fdopendir` and is closed once.
		unsafe { libc::closedir(directory) };

		entries.sort_by(|left, right| {
			left
				.name
				.to_lowercase()
				.cmp(&right.name.to_lowercase())
				.then_with(|| left.name.cmp(&right.name))
		});
		entries.truncate(MAX_DIRECTORY_ENTRIES);
		MaterializedMention::Directory { entries, entry_limit_reached }
	}

	fn modified_at_ms(status: &libc::stat) -> Option<f64> {
		Some(status.st_mtime as f64 * 1000.0 + status.st_mtime_nsec as f64 / 1_000_000.0)
	}
}

#[cfg(target_os = "windows")]
mod platform {
	use std::{
		ffi::OsStr,
		fs::File,
		io::{self, Read},
		os::windows::{
			ffi::OsStrExt,
			io::{AsRawHandle, FromRawHandle, OwnedHandle},
		},
	};

	use windows_sys::{
		Wdk::{
			Foundation::OBJECT_ATTRIBUTES,
			Storage::FileSystem::{
				FILE_DIRECTORY_FILE, FILE_ID_FULL_DIR_INFORMATION, FILE_OPEN, FILE_OPEN_REPARSE_POINT,
				FILE_SYNCHRONOUS_IO_NONALERT, FileIdFullDirectoryInformation, NtCreateFile,
				NtQueryDirectoryFile,
			},
		},
		Win32::{
			Foundation::{
				HANDLE, INVALID_HANDLE_VALUE, OBJ_CASE_INSENSITIVE, STATUS_NO_MORE_FILES,
				UNICODE_STRING,
			},
			Storage::FileSystem::{
				CreateFileW, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
				FILE_ATTRIBUTE_TAG_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
				FILE_GENERIC_READ, FILE_ID_INFO, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
				FileAttributeTagInfo, FileIdInfo, GetFileInformationByHandleEx, OPEN_EXISTING,
			},
			System::IO::IO_STATUS_BLOCK,
		},
	};

	use super::{
		MAX_DIRECTORY_ENTRIES, MAX_IMAGE_BYTES, MAX_TEXT_BYTES, MaterializedMention, SkipReason,
		WorkspaceMentionDirectoryEntry, WorkspaceRootIdentity, supported_image_header,
	};

	pub struct RootHandle(OwnedHandle);

	pub fn read_root_identity(workspace_root: &str) -> io::Result<WorkspaceRootIdentity> {
		let root = open_root(workspace_root)?;
		identity_for_handle(raw_handle(&root))
	}

	pub fn open_verified_root(
		workspace_root: &str,
		expected: &WorkspaceRootIdentity,
	) -> io::Result<RootHandle> {
		if expected.platform != "windows" {
			return Err(io::Error::new(io::ErrorKind::InvalidData, "identity platform mismatch"));
		}
		let root = open_root(workspace_root)?;
		let actual = identity_for_handle(raw_handle(&root))?;
		if actual != *expected {
			return Err(io::Error::new(
				io::ErrorKind::InvalidData,
				"workspace root identity mismatch",
			));
		}
		Ok(RootHandle(root))
	}

	fn open_root(workspace_root: &str) -> io::Result<OwnedHandle> {
		let mut path: Vec<u16> = OsStr::new(workspace_root).encode_wide().collect();
		if path.is_empty() || path.contains(&0) {
			return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid workspace root"));
		}
		path.push(0);
		// SAFETY: `path` is NUL-terminated and the returned handle is adopted once.
		let handle = unsafe {
			CreateFileW(
				path.as_ptr(),
				FILE_GENERIC_READ,
				FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
				std::ptr::null(),
				OPEN_EXISTING,
				FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
				std::ptr::null_mut(),
			)
		};
		if handle == INVALID_HANDLE_VALUE {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: `handle` is valid and ownership transfers here.
		let owned = unsafe { OwnedHandle::from_raw_handle(handle as _) };
		let attributes = attributes_for_handle(handle)?;
		if attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
			|| attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
		{
			return Err(io::Error::new(
				io::ErrorKind::InvalidInput,
				"workspace root is not a plain directory",
			));
		}
		Ok(owned)
	}

	fn raw_handle(handle: &OwnedHandle) -> HANDLE {
		handle.as_raw_handle() as HANDLE
	}

	fn attributes_for_handle(handle: HANDLE) -> io::Result<FILE_ATTRIBUTE_TAG_INFO> {
		let mut attributes = FILE_ATTRIBUTE_TAG_INFO::default();
		// SAFETY: `attributes` is writable and `handle` is open.
		let ok = unsafe {
			GetFileInformationByHandleEx(
				handle,
				FileAttributeTagInfo,
				std::ptr::addr_of_mut!(attributes).cast(),
				std::mem::size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
			)
		};
		if ok == 0 {
			Err(io::Error::last_os_error())
		} else {
			Ok(attributes)
		}
	}

	fn identity_for_handle(handle: HANDLE) -> io::Result<WorkspaceRootIdentity> {
		let mut identity = FILE_ID_INFO::default();
		// SAFETY: `identity` is writable and `handle` is open.
		let ok = unsafe {
			GetFileInformationByHandleEx(
				handle,
				FileIdInfo,
				std::ptr::addr_of_mut!(identity).cast(),
				std::mem::size_of::<FILE_ID_INFO>() as u32,
			)
		};
		if ok == 0 {
			return Err(io::Error::last_os_error());
		}
		let file_id = identity
			.FileId
			.Identifier
			.iter()
			.map(|byte| format!("{byte:02x}"))
			.collect::<String>();
		Ok(WorkspaceRootIdentity {
			platform: "windows".to_string(),
			volume_id: format!("{:016x}", identity.VolumeSerialNumber),
			file_id,
		})
	}

	pub fn read(root: &RootHandle, segments: &[&str]) -> MaterializedMention {
		let target = match open_relative(raw_handle(&root.0), segments) {
			Ok(target) => target,
			Err(reason) => return MaterializedMention::Skipped { reason, byte_size: None },
		};
		let handle = raw_handle(&target);
		let attributes = match attributes_for_handle(handle) {
			Ok(attributes) => attributes,
			Err(_) => {
				return MaterializedMention::Skipped { reason: SkipReason::IoError, byte_size: None };
			},
		};
		if attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return MaterializedMention::Skipped {
				reason: SkipReason::UnsafeSymlink,
				byte_size: None,
			};
		}
		if attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
			read_directory(target)
		} else {
			read_file(target)
		}
	}

	fn open_relative(
		root: HANDLE,
		segments: &[&str],
	) -> std::result::Result<OwnedHandle, SkipReason> {
		let mut parent: Option<OwnedHandle> = None;
		for (index, segment) in segments.iter().enumerate() {
			let parent_handle = parent.as_ref().map_or(root, raw_handle);
			let target = open_child(parent_handle, segment, index + 1 != segments.len())?;
			let attributes =
				attributes_for_handle(raw_handle(&target)).map_err(|_| SkipReason::IoError)?;
			if attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
				return Err(SkipReason::UnsafeSymlink);
			}
			if index + 1 != segments.len() && attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
			{
				return Err(SkipReason::UnsupportedEntry);
			}
			parent = Some(target);
		}
		parent.ok_or(SkipReason::InvalidPath)
	}

	fn open_child(
		parent: HANDLE,
		segment: &str,
		require_directory: bool,
	) -> std::result::Result<OwnedHandle, SkipReason> {
		let mut name: Vec<u16> = OsStr::new(segment).encode_wide().collect();
		if segment.contains(':')
			|| name.is_empty()
			|| name.contains(&0)
			|| name.len() > u16::MAX as usize / 2
		{
			return Err(SkipReason::InvalidPath);
		}
		let unicode = UNICODE_STRING {
			Length: (name.len() * 2) as u16,
			MaximumLength: (name.len() * 2) as u16,
			Buffer: name.as_mut_ptr(),
		};
		let attributes = OBJECT_ATTRIBUTES {
			Length: std::mem::size_of::<OBJECT_ATTRIBUTES>() as u32,
			RootDirectory: parent,
			ObjectName: std::ptr::addr_of!(unicode),
			Attributes: OBJ_CASE_INSENSITIVE,
			SecurityDescriptor: std::ptr::null(),
			SecurityQualityOfService: std::ptr::null(),
		};
		let mut handle: HANDLE = std::ptr::null_mut();
		let mut status_block = IO_STATUS_BLOCK::default();
		let mut create_options = FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT;
		if require_directory {
			create_options |= FILE_DIRECTORY_FILE;
		}
		// SAFETY: all pointers remain live for the call; `parent` is an open
		// directory handle and the output handle is adopted on success.
		let status = unsafe {
			NtCreateFile(
				std::ptr::addr_of_mut!(handle),
				FILE_GENERIC_READ,
				std::ptr::addr_of!(attributes),
				std::ptr::addr_of_mut!(status_block),
				std::ptr::null(),
				0,
				FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
				FILE_OPEN,
				create_options,
				std::ptr::null(),
				0,
			)
		};
		if status < 0 || handle.is_null() {
			return Err(SkipReason::Missing);
		}
		// SAFETY: successful `NtCreateFile` returned an owned handle.
		Ok(unsafe { OwnedHandle::from_raw_handle(handle as _) })
	}

	fn read_file(target: OwnedHandle) -> MaterializedMention {
		let mut file = File::from(target);
		let reported_size = file.metadata().ok().map(|metadata| metadata.len());
		let mut data =
			Vec::with_capacity(reported_size.unwrap_or(0).min(MAX_IMAGE_BYTES as u64) as usize);
		let mut header = [0u8; 12];
		let mut header_len = 0usize;
		while header_len < header.len() {
			match file.read(&mut header[header_len..]) {
				Ok(0) => break,
				Ok(read) => header_len += read,
				Err(_) => {
					return MaterializedMention::Skipped {
						reason: SkipReason::IoError,
						byte_size: None,
					};
				},
			}
		}
		data.extend_from_slice(&header[..header_len]);
		let max_bytes = if supported_image_header(&data) {
			MAX_IMAGE_BYTES
		} else {
			MAX_TEXT_BYTES
		};
		if reported_size.is_some_and(|size| size > max_bytes as u64) {
			return MaterializedMention::Skipped {
				reason: SkipReason::TooLarge,
				byte_size: reported_size,
			};
		}
		let remaining = max_bytes.saturating_add(1).saturating_sub(data.len());
		if file
			.by_ref()
			.take(remaining as u64)
			.read_to_end(&mut data)
			.is_err()
		{
			return MaterializedMention::Skipped { reason: SkipReason::IoError, byte_size: None };
		}
		if data.len() > max_bytes {
			return MaterializedMention::Skipped {
				reason: SkipReason::TooLarge,
				byte_size: Some(data.len() as u64),
			};
		}
		MaterializedMention::File(data)
	}

	fn read_directory(target: OwnedHandle) -> MaterializedMention {
		const BUFFER_SIZE: usize = 256 * 1024;
		const WINDOWS_TICK: i64 = 10_000_000;
		const UNIX_EPOCH_AS_FILETIME: i64 = 116_444_736_000_000_000;
		let handle = raw_handle(&target);
		let mut buffer = vec![0u8; BUFFER_SIZE];
		let mut entries = Vec::new();
		let mut entry_limit_reached = false;
		let mut restart = true;
		'queries: loop {
			let mut status_block = IO_STATUS_BLOCK::default();
			// SAFETY: the handle is a directory and `buffer` is writable.
			let status = unsafe {
				NtQueryDirectoryFile(
					handle,
					std::ptr::null_mut(),
					None,
					std::ptr::null(),
					std::ptr::addr_of_mut!(status_block),
					buffer.as_mut_ptr().cast(),
					buffer.len() as u32,
					FileIdFullDirectoryInformation,
					false,
					std::ptr::null(),
					restart,
				)
			};
			restart = false;
			if status == STATUS_NO_MORE_FILES {
				break;
			}
			if status < 0 {
				return MaterializedMention::Skipped { reason: SkipReason::IoError, byte_size: None };
			}
			let returned_bytes = status_block.Information.min(buffer.len());
			if returned_bytes == 0 {
				return MaterializedMention::Skipped { reason: SkipReason::IoError, byte_size: None };
			}
			let mut offset = 0usize;
			loop {
				if offset + std::mem::size_of::<FILE_ID_FULL_DIR_INFORMATION>() > returned_bytes {
					return MaterializedMention::Skipped {
						reason: SkipReason::IoError,
						byte_size: None,
					};
				}
				// SAFETY: record bounds were checked and records may be unaligned.
				let info = unsafe {
					std::ptr::read_unaligned(
						buffer[offset..]
							.as_ptr()
							.cast::<FILE_ID_FULL_DIR_INFORMATION>(),
					)
				};
				let name_offset = offset + std::mem::offset_of!(FILE_ID_FULL_DIR_INFORMATION, FileName);
				let name_len = info.FileNameLength as usize;
				if name_len % 2 != 0 || name_offset + name_len > returned_bytes {
					return MaterializedMention::Skipped {
						reason: SkipReason::IoError,
						byte_size: None,
					};
				}
				let name_units: Vec<u16> = buffer[name_offset..name_offset + name_len]
					.chunks_exact(2)
					.map(|chunk| u16::from_ne_bytes([chunk[0], chunk[1]]))
					.collect();
				let name = String::from_utf16_lossy(&name_units);
				if name != "."
					&& name != ".."
					&& info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT == 0
				{
					let ticks = info.LastWriteTime.checked_sub(UNIX_EPOCH_AS_FILETIME);
					let modified_at_ms =
						ticks.map(|value| value as f64 / (WINDOWS_TICK as f64 / 1000.0));
					entries.push(WorkspaceMentionDirectoryEntry {
						name,
						is_directory: info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0,
						modified_at_ms,
					});
					if entries.len() > MAX_DIRECTORY_ENTRIES {
						entry_limit_reached = true;
						break 'queries;
					}
				}
				if info.NextEntryOffset == 0 {
					break;
				}
				offset = offset.saturating_add(info.NextEntryOffset as usize);
				if offset >= returned_bytes {
					return MaterializedMention::Skipped {
						reason: SkipReason::IoError,
						byte_size: None,
					};
				}
			}
		}
		entries.sort_by(|left, right| {
			left
				.name
				.to_lowercase()
				.cmp(&right.name.to_lowercase())
				.then_with(|| left.name.cmp(&right.name))
		});
		entries.truncate(MAX_DIRECTORY_ENTRIES);
		MaterializedMention::Directory { entries, entry_limit_reached }
	}
}

#[cfg(not(any(unix, target_os = "windows")))]
mod platform {
	use std::io;

	use super::{MaterializedMention, SkipReason, WorkspaceRootIdentity};

	pub struct RootHandle;

	pub fn read_root_identity(_workspace_root: &str) -> io::Result<WorkspaceRootIdentity> {
		Err(io::Error::new(io::ErrorKind::Unsupported, "unsupported platform"))
	}

	pub fn open_verified_root(
		_workspace_root: &str,
		_expected: &WorkspaceRootIdentity,
	) -> io::Result<RootHandle> {
		Err(io::Error::new(io::ErrorKind::Unsupported, "unsupported platform"))
	}

	pub fn read(_root: &RootHandle, _segments: &[&str]) -> MaterializedMention {
		MaterializedMention::Skipped { reason: SkipReason::IoError, byte_size: None }
	}
}

#[cfg(all(test, unix))]
mod tests {
	use std::{fs, os::unix::fs::symlink, path::PathBuf, time::SystemTime};

	use super::{
		StrictWorkspaceMentionReader, WorkspaceRootIdentity, read_workspace_mention_root_identity,
	};

	struct Fixture(PathBuf);

	impl Fixture {
		fn new(label: &str) -> Self {
			let unique = SystemTime::now()
				.duration_since(SystemTime::UNIX_EPOCH)
				.expect("clock")
				.as_nanos();
			let path = std::env::temp_dir()
				.join(format!("omp-workspace-mention-{label}-{}-{unique}", std::process::id()));
			fs::create_dir_all(&path).expect("create fixture");
			Self(path)
		}
	}

	impl Drop for Fixture {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.0);
		}
	}

	fn reader_for_path(root: &std::path::Path) -> StrictWorkspaceMentionReader {
		let path = root.to_string_lossy().into_owned();
		let identity = read_workspace_mention_root_identity(path.clone()).expect("identity");
		StrictWorkspaceMentionReader::new(path, identity).expect("reader")
	}

	fn reader(root: &Fixture) -> StrictWorkspaceMentionReader {
		reader_for_path(&root.0)
	}

	#[test]
	fn reads_regular_file_from_retained_root() {
		let root = Fixture::new("regular");
		fs::write(root.0.join("note.txt"), b"safe").expect("write");
		let reader = reader(&root);
		let result = reader.read("note.txt".to_string());
		assert_eq!(result.kind, "file");
		assert_eq!(result.data.as_deref(), Some(b"safe".as_slice()));
	}

	#[test]
	fn rejects_symlink_and_root_path_replacement() {
		let parent = Fixture::new("root-parent");
		let outside = Fixture::new("outside");
		let root_path = parent.0.join("workspace");
		let moved_path = parent.0.join("workspace-original");
		fs::create_dir(&root_path).expect("root");
		fs::write(root_path.join("note.txt"), b"inside").expect("inside");
		fs::write(outside.0.join("note.txt"), b"outside-secret").expect("outside");
		let reader = reader_for_path(&root_path);
		fs::rename(&root_path, &moved_path).expect("rename root");
		symlink(&outside.0, &root_path).expect("replace root");

		let result = reader.read("note.txt".to_string());
		assert_eq!(result.kind, "file");
		assert_eq!(result.data.as_deref(), Some(b"inside".as_slice()));
		let _ = fs::remove_file(&root_path);
		let _ = fs::remove_dir_all(&moved_path);
	}

	#[test]
	fn identity_mismatch_and_dispose_fail_closed() {
		let root = Fixture::new("identity");
		let path = root.0.to_string_lossy().into_owned();
		let actual = read_workspace_mention_root_identity(path.clone()).expect("identity");
		let mismatch = WorkspaceRootIdentity { file_id: format!("{}0", actual.file_id), ..actual };
		assert!(StrictWorkspaceMentionReader::new(path.clone(), mismatch).is_err());
		let reader = reader(&root);
		assert!(reader.dispose());
		assert!(!reader.dispose());
		assert_eq!(reader.read("note.txt".to_string()).reason.as_deref(), Some("disposed"));
	}
}
